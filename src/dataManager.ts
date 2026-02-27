import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WindowNode } from './types';
import { buildDedupKeys, toRelativeTime, normalizeSavedCandidate } from './helpers';
import { TrackerService } from './trackerService';
import { SavedService } from './savedService';

export type WindowRecord = {
  title?: string;
  path?: string;
  uri?: string;
  pid?: number;
  windowId?: number | string;
  lastActive?: number;
  source?: string;
  status?: string;
};

/**
 * 管理保存和跟踪窗口记录的核心服务。负责：
 *
 * 1. 从多种来源（daemon 文件、tracker 目录、当前工作区）收集
 *    窗口信息并去重。
 * 2. 维护用户“已保存”列表，对外提供增删查改接口并持久化到
 *    可编辑的 saved.json 以及 globalState 中。
 * 3. 启动/停止 `TrackerService` 以产生实时心跳文件。
 * 4. 为树视图提供格式化、图标、上下文值等辅助函数。
 *
 * 原理简述：
 * - 去重通过若干字段（URI、路径、标题）生成键，并保留最新的
 *   lastActive 记录。
 * - 保存列表使用 Array+Set 组合，保证顺序可预测、查找快速。
 * - 所有路径相关配置会展开 `~`，并优先读取用户可编辑的 tracker
 *   目录下的 saved.json。
 * - I/O 操作抽象为可替换的 `fsImpl`，方便单元测试注入模拟文件系统。
 *
 * 该类已经整合原先的 SavedService、TrackedService 和 TrackerService
 * 的调用逻辑，旨在对外提供统一的接口，简化树提供者的依赖。
 */
export class DataManager {
  
  private tracker?: TrackerService;
  private readonly fsImpl: typeof fs = fs;
  private readonly savedSvc: SavedService;

  constructor(private readonly context: vscode.ExtensionContext, options?: { fs?: typeof fs }) {
    this.fsImpl = options?.fs ?? fs;
    // 新的 API 首选 globalStorageUri；globalStoragePath 已弃用且可能为 undefined。
    // 为兼容旧主机和测试环境，进行回退处理以确保正常工作。
    const storageBase = this.context.globalStorageUri?.fsPath ?? this.context.globalStoragePath ?? os.homedir();
    try {
      void this.fsImpl.mkdir(storageBase, { recursive: true });
    } catch {
      // ignore
    }

    // 优先使用 tracker 目录下可编辑的 saved.json
    const trackerDir = this.resolveConfigPath('trackerDir', '~/.vscode-window-tracker');
    void (async () => {
      try {
        await this.fsImpl.mkdir(trackerDir, { recursive: true });
      } catch {
        // ignore
      }
    })();

    // initialize saved service after trackerDir is known
    this.savedSvc = new SavedService(this.context, { fs: this.fsImpl, trackerDir });
  }

  // ---------- 已保存集合助手（委托） ----------
  public getSavedArray(): string[] {
    return this.savedSvc.getSavedArray();
  }

  public async persistSavedArray(arr: string[]): Promise<void> {
    return this.savedSvc.persistSavedArray(arr);
  }


  // 原子化写 JSON 到磁盘（先写临时文件再重命名）

  /** 将 ~ 开头路径展开为用户主目录 */
  private expandHome(raw: string): string {
    return raw.replace(/^~(?=$|\/|\\)/, os.homedir());
  }

  /**
   * 从磁盘读取并解析 JSON，失败时返回 undefined（不会抛出）。
   */
  private async readJson(filePath: string): Promise<any | undefined> {
    try {
      const content = await this.fsImpl.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch {
      return undefined;
    }
  }

  /**
   * 获取配置项并展开 '~'。主要用于目录或文件路径。
   */
  private resolveConfigPath(key: string, fallback: string): string {
    const raw = this.getConfig<string>(key, fallback);
    return this.expandHome(raw);
  }


  /**
   * 获取扩展配置项，若未设置则返回默认值。公开给 UI 模块使用。
   */
  public getConfig<T = any>(key: string, fallback?: T): T {
    const cfg = vscode.workspace.getConfiguration('vscode-window-tracker');
    const val = cfg.get<T>(key as any);
    return (val === undefined ? (fallback as T) : val) as T;
  }

  public buildDedupKeys(record: WindowRecord): string[] {
    // wrapper preserved for backwards compatibility
    return buildDedupKeys(record);
  }

  // 从所有来源加载记录并去重
  public async loadAllRecords(): Promise<WindowRecord[]> {
    const fromTracker = await this.loadTrackerFiles();
    const fromWorkspace = this.loadCurrentWorkspaceRecord();
    return this.dedupe([fromWorkspace, ...fromTracker]);
  }

  // 使用 tracker 文件和当前工作区作为数据来源。

  // 构造当前工作区的临时记录，用于列表顶部显示
  private loadCurrentWorkspaceRecord(): WindowRecord {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const folderPath = workspaceFolder?.uri.fsPath;
    return {
      title: vscode.window.activeTextEditor?.document.fileName ? path.basename(vscode.window.activeTextEditor.document.fileName) : 'Current Workspace',
      path: folderPath,
      uri: workspaceFolder?.uri.toString(),
      lastActive: Date.now(),
      source: 'vscode',
      status: 'focused',
    };
  }

  // 从 tracker 目录读取所有 JSON 文件，忽略过期项
  private async loadTrackerFiles(): Promise<WindowRecord[]> {
    const trackerDir = this.resolveConfigPath('trackerDir', '~/.vscode-window-tracker');
    const staleMinutes = this.getConfig<number>('trackerFileStaleMinutes', 30);
    const cutoff = Date.now() - (staleMinutes ?? 30) * 60 * 1000;
    try {
      const files = await this.fsImpl.readdir(trackerDir);
      const jsonFiles = files.filter((file) => file.endsWith('.json'));
      const records = await Promise.all(jsonFiles.map(async (file) => {
        const filePath = path.join(trackerDir, file);
        const raw = await this.readJson(filePath);
        if (!raw) return [];
        const candidate = Array.isArray(raw) ? raw : (raw && raw.windows ? raw.windows : [raw]);
        if (Array.isArray(candidate)) {
          const filtered = candidate.filter((r: any) => {
            if (!r || typeof r !== 'object') return false;
            if (typeof r.lastActive === 'number') return r.lastActive >= cutoff;
            return true;
          });
          // snapshot write removed — no longer persist filtered tracker snapshots
          return filtered as WindowRecord[];
        }
        return [];
      }));
      return records.flat();
    } catch {
      return [];
    }
  }

  // 根据去重键保留最新记录
  private dedupe(records: WindowRecord[]): WindowRecord[] {
    const map = new Map<string, WindowRecord>();
    for (const record of records) {
      const keys = this.buildDedupKeys(record);
      const winnerKey = keys.find((key) => map.has(key));
      if (winnerKey) {
        const current = map.get(winnerKey)!;
        if ((record.lastActive ?? 0) > (current.lastActive ?? 0)) {
          map.set(winnerKey, record);
        }
        continue;
      }
      map.set(keys[0], record);
    }
    return [...map.values()];
  }

  // ---------- saved set helpers (delegated) ----------
  public isSaved(stableId: string): boolean {
    return this.savedSvc.isSaved(stableId);
  }

  public async save(stableId: string): Promise<void> {
    await this.savedSvc.save(stableId);
  }

  public async removeSaved(stableId: string): Promise<void> {
    await this.savedSvc.remove(stableId);
  }

  public getAllSaved(): string[] {
    return this.savedSvc.getAllSaved();
  }

  public buildSavedNodes(trackedById?: Map<string, WindowNode>): WindowNode[] {
    return this.savedSvc.buildSavedNodes(trackedById);
  }

  private normalizeSavedCandidate(savedId: string, lastActiveOverride?: number): WindowNode {
    return normalizeSavedCandidate(savedId, lastActiveOverride);
  }

  // ---------- tracked helpers ----------
  // 将 WindowRecord 转换为 Tree 节点
  public normalizeTrackedNodes(records: WindowRecord[]): WindowNode[] {
    const now = Date.now();
    const enriched: WindowNode[] = records.map((record, index) => {
      const stableId = (buildDedupKeys(record) || [])[0] || `${record.path || record.title || 'window'}-${index}`;
      let dirUri: vscode.Uri | undefined = undefined;
      if (record.uri) {
        try {
          dirUri = vscode.Uri.parse(record.uri);
        } catch {
          dirUri = undefined;
        }
      } else if (record.path) {
        try {
          dirUri = vscode.Uri.file(record.path);
        } catch {
          dirUri = undefined;
        }
      }
      const lastActive = record.lastActive ?? now;
      return {
        type: 'window',
        ...record,
        stableId,
        origin: 'tracked',
        dirUri,
        relativeActive: toRelativeTime(lastActive, now),
      } as WindowNode;
    });

    const sorted = enriched.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
    return sorted;
  }


  // ---------- combined node list ----------
  // 合并已保存和跟踪节点，确保排序和标记
  public async getWindowNodes(): Promise<WindowNode[]> {
    const loaded = await this.loadAllRecords();
    const trackedNodes = this.normalizeTrackedNodes(loaded);
    const trackedById = new Map(trackedNodes.map(n => [n.stableId, n]));
    let addedNodes = this.buildSavedNodes(trackedById);
    const standaloneAdded: WindowNode[] = [];
    for (const a of addedNodes) {
      const t = trackedById.get(a.stableId);
      if (t) {
        t.isSaved = true;
      } else {
        standaloneAdded.push(a);
      }
    }
    addedNodes = standaloneAdded;
    const nodes = [...trackedNodes, ...addedNodes].sort((a, b) => {
      if (a.origin !== b.origin) return a.origin === 'tracked' ? -1 : 1;
      return (b.lastActive ?? 0) - (a.lastActive ?? 0);
    });
    return nodes;
  }

  // ---------- tracker helpers delegated to internal class ----------
  public startTracker(): void {
    if (!this.tracker) {
      this.tracker = new TrackerService(this.context, { fs: this.fsImpl });
    }
    this.tracker.start();
  }

  public stopTracker(): void {
    if (this.tracker) {
      this.tracker.stop();
      this.tracker = undefined;
    }
  }
}

export function createDataManager(ctx: vscode.ExtensionContext, options?: { fs?: typeof fs }) {
  return new DataManager(ctx, options);
}

/**
 * 决定记录在树视图中显示的标题。
 * 优先显示文件/URI 的 basename，回退为原始 title。
 */
export function formatTitle(node: WindowNode): string {
  if (node.path) {
    return path.basename(node.path);
  }
  if (node.uri) {
    try {
      const u = vscode.Uri.parse(node.uri);
      return path.basename(u.fsPath) || path.posix.basename(u.path) || u.toString();
    } catch {
      // ignore
    }
  }
  return node.title || 'Untitled Window';
}

/**
 * 生成显示在树项右侧的简短描述。
 */
export function buildDescription(node: WindowNode): string {
  return `${node.relativeActive}`;
}

/**
 * 为项构建 Markdown 格式的提示信息。
 */
export function buildTooltip(node: WindowNode): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${node.title || 'Untitled Window'}**\n\n`);
  md.appendMarkdown(`- path: ${node.path || '-'}\n`);
  md.appendMarkdown(`- pid: ${node.pid ?? '-'}\n`);
  md.appendMarkdown(`- lastActive: ${node.lastActive ? new Date(node.lastActive).toLocaleString() : '-'}\n`);
  md.appendMarkdown(`- source: ${node.source || '-'}\n`);
  md.appendMarkdown(`- status(raw): ${node.status || '-'}\n`);
  md.isTrusted = false;
  return md;
}

/**
 * 用于菜单贡献的上下文值字符串。
 */
export function buildContextValue(node: WindowNode): string {
  if (node.origin === 'saved') {
    return 'windowItem:saved';
  }
  if (node.origin === 'tracked') {
    if (node.isSaved) return 'windowItem:tracked:saved';
    return 'windowItem:tracked:allowAdd';
  }
  return 'windowItem:tracked';
}

/**
 * 为树项选择图标。
 * 如果记录对应当前打开的工作区文件夹，则 `isCurrentWorkspace` 应为 true。
 */
export function getNodeIcon(node: WindowNode, isCurrentWorkspace: boolean, dataManager: DataManager): vscode.ThemeIcon {
  const added = (typeof node.isSaved === 'boolean') ? node.isSaved : dataManager.isSaved(node.stableId);
  if (isCurrentWorkspace) {
    return new vscode.ThemeIcon('repo', new vscode.ThemeColor('charts.blue'));
  }
  if (node.origin === 'tracked') {
    return new vscode.ThemeIcon('repo');
  }
  return added ? new vscode.ThemeIcon('database') : new vscode.ThemeIcon('repo', new vscode.ThemeColor('disabledForeground'));
}

/**
 * 计算相对时间字符串（委托给 helper 保持一致）。
 */
export { toRelativeTime };

/**
 * 将 path/uri 对转换为适用于 openFolder 的 Uri 对象。
 */
export function toDirUri(recordPath?: string, recordUri?: string): vscode.Uri | undefined {
  if (recordUri) {
    try {
      return vscode.Uri.parse(recordUri);
    } catch {
      return undefined;
    }
  }
  if (!recordPath) {
    return undefined;
  }
  return vscode.Uri.file(recordPath);
}

/**
 * 如果提供的记录 path 或 uri 与任意工作区文件夹匹配则返回 true。
 */
export function isCurrentWorkspace(recordPath?: string, recordUri?: string): boolean {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    return false;
  }
  if (recordPath) {
    for (const folder of vscode.workspace.workspaceFolders) {
      if (folder.uri.fsPath === recordPath) {
        return true;
      }
    }
  }
  if (recordUri) {
    try {
      const uri = vscode.Uri.parse(recordUri);
      for (const folder of vscode.workspace.workspaceFolders) {
        if (folder.uri.fsPath === uri.fsPath) {
          return true;
        }
      }
    } catch {
      // ignore parse errors
    }
  }
  return false;
}
