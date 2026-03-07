import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigService } from './configService';
const configService = ConfigService.getInstance();

/**
 * Tracks the current VS Code workspace/window and writes periodic heartbeat
 * records to a JSON file for external monitors. Intended for use by
 * `DataManager` or directly from tests.
 *
 * 本类在后台维护一个会话级的 tracker 文件，周期性（以及在窗口/编辑
 * 器状态变化时）更新当前会话信息，以便外部进程能够检测活动的 VS Code
 * 实例与打开的工作区。
 *
 * 要点：
 * - 原子写入：先写入 `<file>.tmp` 再重命名以避免半写入状态。
 * - 心跳间隔可配置，配置项为 `heartbeatIntervalSeconds`。
 * - 监听 `exit`、`SIGINT`、`SIGTERM` 与 `uncaughtException`，确保扩展
 *   停用或崩溃时删除本进程对应的文件以防残留。
 * - 路径会写入 `context.globalState`，便于跨会话清理与恢复旧记录的属主信息。
 *
 * 设计原则：保持实现简单、可测试，并允许通过注入 `fs` 实现进行单元测试。
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
        // 仅处理扩展写入的 tracker 文件，避免将 saved.json 或其他任意 json 误识别为 tracker
        if (!f.endsWith('.json') || !f.startsWith('vscode-')) continue;
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

  /**
   * Read and return all recent tracker records from disk.
   * This mirrors the logic previously maintained by DataManager:
   * - supports files that contain a single record, an array, or an object
   *   with a `windows` array.
   * - filters out stale records by `lastActive` using the same cutoff.
   */
  public async readTrackedRecords(): Promise<any[]> {
    const trackerDir = configService.trackerDir;
    const staleMinutes = configService.trackerFileStaleMinutes;
    const cutoff = Date.now() - (staleMinutes ?? 30) * 60 * 1000;
    try {
      const files = await this.fsImpl.readdir(trackerDir).catch(() => []);
      // 只读取以 vscode- 前缀生成的 tracker 文件，排除 saved.json 等用户文件
      const jsonFiles = (files || []).filter((f: string) => f.endsWith('.json') && f.startsWith('vscode-'));
      const records = await Promise.all(
        jsonFiles.map(async (file: string) => {
          const filePath = path.join(trackerDir, file);
          try {
            const content = await this.fsImpl.readFile(filePath, 'utf8');
            const raw = JSON.parse(content);
            const candidate = Array.isArray(raw) ? raw : raw && raw.windows ? raw.windows : [raw];
            if (Array.isArray(candidate)) {
              const filtered = candidate.filter((r: any) => {
                if (!r || typeof r !== 'object') return false;
                if (typeof r.lastActive === 'number') return r.lastActive >= cutoff;
                return true;
              });
              return filtered;
            }
          } catch {
            // ignore read/parse errors for individual files
          }
          return [];
        })
      );
      return records.flat();
    } catch {
      return [];
    }
  }
}
