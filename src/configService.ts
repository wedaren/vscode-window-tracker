import * as vscode from 'vscode';
import * as os from 'os';

/**
 * ConfigService: 集中式配置读取与变更通知服务
 *
 * @docs ConfigService
 *
 * 说明（中文）：
 * 该类负责统一读取扩展的配置项（配置节：`vscode-window-tracker`），
 * 将常用配置解析并缓存为实例字段，便于全局消费方直接使用。
 * 同时监听 `workspace.onDidChangeConfiguration`，在配置发生变化
 * 并影响本扩展配置节时重新加载并通过 `onDidChange` 事件通知订阅者。
 */
/**
 * Tracker 相关配置（职责单一：文件路径与过期/清理策略）
 *
 * @docs TrackerOptions
 */
interface TrackerOptions {
  /** tracker 文件目录（已展开 ~） */
  trackerDir: string;
  /** tracker 文件过期分钟数 */
  fileStaleMinutes: number;
  /** 启用自动清理过期 tracker 文件 */
  autoCleanup: boolean;
}

/**
 * 心跳相关配置（职责单一：心跳频率）
 *
 * @docs HeartbeatOptions
 */
interface HeartbeatOptions {
  /** 心跳间隔（秒） */
  intervalSeconds: number;
}

/**
 * 配置对象的类型定义（组合式，便于职责分离）
 *
 * @docs ConfigOptions
 */
interface ConfigOptions {
  tracker: TrackerOptions;
  heartbeat: HeartbeatOptions;
}

interface ConfigServiceOptions {
  /** 是否在构造时立即加载配置（默认 true） */
  autoLoad?: boolean;
  /** 是否订阅 workspace 配置变化（默认 true） */
  watch?: boolean;
  /** 可选的配置节覆盖，默认 'vscode-window-tracker' */
  section?: string;
}

export class ConfigService {
  /** 模块级单例（按需创建） */
  private static _instance: ConfigService | undefined;

  /**
   * @docs getInstance
   * 获取全局单例实例（首次调用时会创建，后续返回同一实例）。
   * @param opts 可选构造参数，仅在首次创建时生效
   */
  public static getInstance(opts?: ConfigServiceOptions): ConfigService {
    if (!this._instance) {
      this._instance = new ConfigService(opts);
    }
    return this._instance;
  }
  /** 内部变更事件发射器（不携带负载） */
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** 对外暴露的变更事件，订阅者可在配置变化时做相应处理 */
  /**
   * @docs onDidChange
   * 当扩展配置发生变化时发出的事件（无负载）。
   */
  public readonly onDidChange = this._onDidChange.event;

  /** 配置节名 */
  private section = 'vscode-window-tracker';
  private disposable: vscode.Disposable | undefined;
  /** 标记是否已加载配置（用于按需/延迟加载） */
  private loaded = false;

  // 下面为常用配置的已初始化字段，直接读取避免重复调用 getConfiguration
  /** tracker 文件目录（已展开 ~） */
  /**
   * @docs trackerDir
   * 已解析并展开的 tracker 目录路径。
   */
  public trackerDir!: string;
  /** 心跳间隔（秒） */
  /**
   * @docs heartbeatIntervalSeconds
   * 心跳间隔（秒），用于控制刷新与写入频率。
   */
  public heartbeatIntervalSeconds!: number;
  /** tracker 文件过期分钟数 */
  /**
   * @docs trackerFileStaleMinutes
   * 判定 tracker 文件为过期的分钟阈值。
   */
  public trackerFileStaleMinutes!: number;
  /** 启用自动清理过期 tracker 文件 */
  /**
   * @docs trackerAutoCleanup
   * 指示是否在启动时自动清理过期的 tracker 文件。
   */
  public trackerAutoCleanup!: boolean;

  /**
   * 获取当前已解析并缓存的完整配置对象。
   * @docs getAll
   */
  public getAll(): ConfigOptions {
    this.ensureLoaded();
    return {
      tracker: {
        trackerDir: this.trackerDir,
        fileStaleMinutes: this.trackerFileStaleMinutes,
        autoCleanup: this.trackerAutoCleanup,
      },
      heartbeat: {
        intervalSeconds: this.heartbeatIntervalSeconds,
      },
    };
  }

  /**
   * @docs getTrackerOptions
   * 返回按类型的 `TrackerOptions`，包含 tracker 目录与清理设置。
   */
  public getTrackerOptions(): TrackerOptions {
    this.ensureLoaded();
    return {
      trackerDir: this.trackerDir,
      fileStaleMinutes: this.trackerFileStaleMinutes,
      autoCleanup: this.trackerAutoCleanup,
    };
  }

  /**
   * @docs getHeartbeatOptions
   * 返回心跳相关的配置对象 `HeartbeatOptions`。
   */
  public getHeartbeatOptions(): HeartbeatOptions {
    this.ensureLoaded();
    return {
      intervalSeconds: this.heartbeatIntervalSeconds,
    };
  }

  /**
   * 构造函数：可选延迟加载与可选订阅配置变更
   * @param opts 可选项：{ autoLoad=true, watch=true, section }
   */
  constructor(opts?: ConfigServiceOptions) {
    if (opts?.section) {
      this.section = opts.section;
    }

    const watch = opts?.watch ?? true;
    if (watch) {
      // 订阅 workspace 配置变更，若影响本扩展配置节则重新加载并发出事件
      this.disposable = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(this.section)) {
          this.load();
          this._onDidChange.fire();
        }
      });
    }

    const autoLoad = opts?.autoLoad ?? true;
    if (autoLoad) {
      // 初始加载配置到实例字段（保持向后兼容）
      this.load();
    }
  }

  /**
   * @docs load
   * 从 workspace configuration 读取并解析配置到实例字段（会设置 loaded 标志）。
   */
  public load(): void {
    const cfg = vscode.workspace.getConfiguration(this.section);
    const rawTrackerDir = cfg.get<string>('trackerDir', '~/.vscode-window-tracker')!;
    this.trackerDir = rawTrackerDir.replace(/^~(?=$|\/|\\)/, os.homedir());
    this.heartbeatIntervalSeconds = cfg.get<number>('heartbeatIntervalSeconds', 5) ?? 5;
    this.trackerFileStaleMinutes = cfg.get<number>('trackerFileStaleMinutes', 30) ?? 30;
    this.trackerAutoCleanup = cfg.get<boolean>('trackerAutoCleanup', true) ?? true;
    this.loaded = true;
  }

  /** 确保已加载（按需/延迟加载支持） */
  private ensureLoaded(): void {
    if (!this.loaded) {
      this.load();
    }
  }

  /**
   * @docs get
   * 通用读取接口：返回指定配置键的值或回退值。
   * @param key 配置键
   * @param fallback 未设置时的回退值
   */
  public get<T = unknown>(key: string, fallback?: T): T {
    this.ensureLoaded();
    const cfg = vscode.workspace.getConfiguration(this.section);
    const val = cfg.get<T>(key as any);
    return (val === undefined ? (fallback as T) : val) as T;
  }

  /**
   * @docs resolvePath
   * 展开以 `~` 开头的路径配置为用户主目录并返回。
   * @param key 配置键
   * @param fallback 回退路径
   */
  public resolvePath(key: string, fallback: string): string {
    this.ensureLoaded();
    const raw = this.get<string>(key, fallback);
    return raw.replace(/^~(?=$|\/|\\)/, os.homedir());
  }

  /**
   * @docs dispose
   * 清理订阅与内部资源（释放 EventEmitter 与 disposables）。
   */
  public dispose(): void {
    this.disposable?.dispose();
    this._onDidChange.dispose();
  }
}

// 注意：此模块现在只导出 `ConfigService`，其它类型为内部实现细节。
