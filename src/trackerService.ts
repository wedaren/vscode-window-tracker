import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigService } from './configService';
const configService = ConfigService.getInstance();

/**
 * Tracks the current workspace/window and emits periodic heartbeats to a
 * JSON file.  Designed to be used by `DataManager` or directly in tests.
 *
 * 该类负责在后台定期将当前窗口/工作区状态写入一个 tracker 文件，
 * 供外部程序监视。心跳与 VS Code 窗口状态、活动编辑器事件共同
 * 驱动写操作，以保持信息最新。为了降低 I/O 频率，窗口/编辑器事件
 * 使用节流函数合并。
 *
 * 原理简述：
 * 1. 原子写入：先写到 `<file>.tmp` 后重命名，避免发生半写入。
 * 2. 心跳间隔可配置；配置键 `heartbeatIntervalSeconds`。
 * 3. 监听 `exit`、`SIGINT`、`SIGTERM` 和 `uncaughtException` 保证
 *    扩展停用时删除本进程对应的文件，避免残留。
 * 4. 文件路径存储在 `context.globalState`，便于跨会话恢复/清理。
 *
 * 历史说明：早期版本中此类独立存在，2026 年重构时被合并到
 * DataManager，本次又拆回单文件模块以提高测试和维护便利。
 */
export class TrackerService {
  private context: vscode.ExtensionContext;
  private trackerFilePath: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private windowStateListener: vscode.Disposable | undefined;
  private activeEditorListener: vscode.Disposable | undefined;
  private boundExitHandler: () => void;
  private boundSigintHandler: () => void;
  private boundSigtermHandler: () => void;
  private boundUncaughtHandler: (error: Error) => void;

  // used to coalesce rapid events so we don't spawn many concurrent writes
  private pendingWrite: NodeJS.Timeout | undefined;

  // allow injecting an fs-like implementation for testing
  private readonly fsImpl: typeof fs = fs;

  constructor(context: vscode.ExtensionContext, options?: { fs?: typeof fs }) {
    this.context = context;
    this.fsImpl = options?.fs ?? fs;

    this.trackerFilePath = undefined;

    this.boundExitHandler = () => {
      if (this.trackerFilePath) {
        try {
          // The 'exit' handler must be synchronous.
          require('fs').unlinkSync(this.trackerFilePath);
        } catch {
          // ignore, file might not exist
        }
      }
    };
    this.boundSigintHandler = () => {
      process.exit(130);
    };
    this.boundSigtermHandler = () => {
      process.exit(137);
    };
    this.boundUncaughtHandler = (error: Error) => {
      // eslint-disable-next-line no-console
      console.error('Uncaught exception:', error);
      process.exit(1);
    };
  }

  start(): void {
    // 服务启动时先执行一次清理，移除目录中陈旧的 tracker 文件。
    void this.startupCleanup();
    // 初次立即写入当前会话状态。
    void this.writeNow();

    // 设置心跳定时器，定期更新文件内容。
    this.timer = setInterval(() => {
      void this.writeNow();
    }, configService.heartbeatIntervalSeconds * 1000);

    // 监听 VS Code 窗口状态和活动编辑器变化，事件可能非常频繁；
    // 使用 scheduleWrite() 来节流，避免在短时间内多次 I/O。
    this.windowStateListener = vscode.window.onDidChangeWindowState(() => this.scheduleWrite());
    this.activeEditorListener = vscode.window.onDidChangeActiveTextEditor(() =>
      this.scheduleWrite()
    );

    // 注册进程信号处理，确保在退出或异常时删除 tracker 文件。
    process.on('exit', this.boundExitHandler);

    // 清除任何挂起的写入计划（理论上不会有）。
    if (this.pendingWrite) {
      clearTimeout(this.pendingWrite);
      this.pendingWrite = undefined;
    }
    process.on('SIGINT', this.boundSigintHandler);
    process.on('SIGTERM', this.boundSigtermHandler);
    process.on('uncaughtException', this.boundUncaughtHandler);
  }

  stop(): void {
    // 清理所有运行时资源：定时器、事件监听器和信号处理。
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.windowStateListener) {
      this.windowStateListener.dispose();
      this.windowStateListener = undefined;
    }
    if (this.activeEditorListener) {
      this.activeEditorListener.dispose();
      this.activeEditorListener = undefined;
    }
    try {
      process.off('exit', this.boundExitHandler);
    } catch {}
    try {
      process.off('SIGINT', this.boundSigintHandler);
    } catch {}
    try {
      process.off('SIGTERM', this.boundSigtermHandler);
    } catch {}
    try {
      process.off('uncaughtException', this.boundUncaughtHandler);
    } catch {}

    // 取消任何排队的写操作
    if (this.pendingWrite) {
      clearTimeout(this.pendingWrite);
      this.pendingWrite = undefined;
    }

    // 停用时尝试删除当前会话文件。
    void this.removeNow();
  }

  async ensureDir(): Promise<void> {
    // 确保 tracker 目录存在；失败时静默忽略。
    try {
      await this.fsImpl.mkdir(configService.trackerDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  async writeNow(): Promise<void> {
    // 取消可能存在的排队，因为我们马上要写了。
    if (this.pendingWrite) {
      clearTimeout(this.pendingWrite);
      this.pendingWrite = undefined;
    }
    // 每次写入前确保目录存在。
    await this.ensureDir();
    // 如果之前已有文件路径，检查是否仍然属于当前进程。
    if (this.trackerFilePath) {
      try {
        const existing = await this.fsImpl.readFile(this.trackerFilePath, 'utf8');
        try {
          const parsed = JSON.parse(existing);
          // 如果文件归属于其他进程，则放弃复用路径。
          if (parsed && typeof parsed.pid === 'number' && parsed.pid !== process.pid) {
            this.trackerFilePath = undefined;
          }
        } catch {
          // 解析失败时不信任旧文件。
          this.trackerFilePath = undefined;
        }
      } catch {
        // 无法读取文件时创建新路径。
        this.trackerFilePath = undefined;
      }
    }

    if (!this.trackerFilePath) {
      const fname = `vscode-${process.pid}-${Date.now()}.json`;
      this.trackerFilePath = path.join(configService.trackerDir, fname);
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const folderPath = workspaceFolder?.uri.fsPath;
    const status = vscode.window.state.focused ? 'focused' : 'visible';

    // 计算 lastActive，如果当前窗口不聚焦则重用已有值。
    let lastActiveValue = Date.now();
    if (status !== 'focused') {
      try {
        const existingPath =
          this.trackerFilePath ??
          ((await this.context.globalState.get('vscode-window-tracker.trackerFile')) as
            | string
            | undefined);
        if (existingPath) {
          const existing = await this.fsImpl.readFile(existingPath, 'utf8').catch(() => undefined);
          if (existing) {
            try {
              const parsed = JSON.parse(existing);
              if (parsed && typeof parsed.lastActive === 'number') {
                lastActiveValue = parsed.lastActive;
              }
            } catch {
              // ignore parse errors and keep now as fallback
            }
          }
        }
      } catch {
        // ignore read errors
      }
    }

    const rec = {
      title: vscode.window.activeTextEditor?.document.fileName
        ? path.basename(vscode.window.activeTextEditor.document.fileName)
        : 'Current Workspace',
      path: folderPath,
      uri: workspaceFolder?.uri.toString(),
      pid: process.pid,
      lastActive: lastActiveValue,
      source: 'vscode-extension',
      status,
    };

    try {
      const tmp = `${this.trackerFilePath}.tmp`;
      await this.fsImpl.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
      await this.fsImpl.rename(tmp, this.trackerFilePath);
      // 将文件路径写入 globalState 以便跨会话清理。
      try {
        await this.context.globalState.update(
          'vscode-window-tracker.trackerFile',
          this.trackerFilePath
        );
      } catch {
        // ignore failures to update global state in environments where it's not available
      }
    } catch (e) {
      // 与旧行为保持一致：记录错误但不抛出。
      // eslint-disable-next-line no-console
      console.error('Failed to write tracker file', e);
    }
  }

  async removeNow(): Promise<void> {
    // 删除当前 tracker 文件，如果内存中没有路径则尝试从 globalState 恢复。
    if (!this.trackerFilePath) {
      try {
        const stored = await this.context.globalState.get('vscode-window-tracker.trackerFile');
        if (typeof stored === 'string') {
          this.trackerFilePath = stored;
        }
      } catch {
        // ignore
      }
    }
    if (!this.trackerFilePath) return;
    try {
      await this.fsImpl.unlink(this.trackerFilePath);
    } catch {
      // ignore
    }
    this.trackerFilePath = undefined;
    try {
      await this.context.globalState.update('vscode-window-tracker.trackerFile', undefined);
    } catch {
      // ignore
    }
  }

  /**
   * 辅助函数：在短时间内多次调用时只执行一次 `writeNow`。
   * 防止焦点切换/编辑器变更等事件导致频繁 I/O。
   */
  /**
   * @docs scheduleWrite
   * 合并短时间内多个写入请求，延迟并只执行一次 `writeNow`。
   */
  public scheduleWrite(): void {
    if (this.pendingWrite) {
      clearTimeout(this.pendingWrite);
    }
    // 延迟写入 100ms，期间若有更多调用会重置定时器。
    this.pendingWrite = setTimeout(() => {
      this.pendingWrite = undefined;
      void this.writeNow();
    }, 100);
  }

  private async startupCleanup(): Promise<void> {
    // 清理 trackerDir 中过期的 json 文件。
    if (!configService.trackerAutoCleanup) return;
    try {
      const cutoff = Date.now() - configService.trackerFileStaleMinutes * 60 * 1000;
      const files = await this.fsImpl.readdir(configService.trackerDir).catch(() => []);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const fp = path.join(configService.trackerDir, f);
        try {
          const c = await this.fsImpl.readFile(fp, 'utf8');
          const parsed = JSON.parse(c);
          const last =
            parsed && typeof parsed.lastActive === 'number' ? parsed.lastActive : undefined;
          if (last && last < cutoff) {
            await this.fsImpl.unlink(fp).catch(() => {});
          }
        } catch {
          // ignore parse/read errors
        }
      }
    } catch {
      // ignore
    }
  }
}
