import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigService } from './configService';
const configService = ConfigService.getInstance();
import { WindowNode, WindowRecord, SavedItem } from './types';
import { buildDedupKeys, toRelativeTime } from './helpers';
import { TrackerService } from './trackerService';
import { SavedService } from './savedService';

/**
 * 管理保存和跟踪窗口记录的核心服务。负责：
 *
 * 1. 从多种来源（tracker 目录、当前工作区、以及 saved.json/globalState 中的“已保存”列表）收集
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
    const storageBase = this.context.globalStorageUri?.fsPath || '';
    if (storageBase) {
      try {
        void this.fsImpl.mkdir(storageBase, { recursive: true });
      } catch { }
    }

    const trackerDir = configService.trackerDir;
    if (trackerDir) {
      void (async () => {
        try {
          await this.fsImpl.mkdir(trackerDir, { recursive: true });
        } catch { }
      })();
    }

    this.savedSvc = new SavedService(this.context, { fs: this.fsImpl, trackerDir });
  }

  /**
   * @docs getSavedArray
   * 返回 `SavedService` 当前的保存数组拷贝。
   */
  public getSavedArray(): string[] {
    return this.savedSvc.getSavedArray();
  }

  /**
   * @docs persistSavedArray
   * 将保存数组持久化到 `globalState` 与 `saved.json`。
   */
  public async persistSavedArray(arr: SavedItem[]): Promise<void> {
    return this.savedSvc.persistSavedArray(arr);
  }


  /**
   * @docs buildDedupKeys
   * 包装器：为给定记录生成去重键数组。
   */
  public buildDedupKeys(record: WindowRecord): string[] {
    return buildDedupKeys(record);
  }

  /**
   * @docs loadAllRecords
   * 从 tracker 文件和当前 workspace 读取并合并所有记录（含去重）。
   */
  public async loadAllRecords(): Promise<WindowRecord[]> {
    const fromTracker = await this.loadTrackerFiles();
    const fromWorkspace = this.loadCurrentWorkspaceRecord();
    return this.dedupe([fromWorkspace, ...fromTracker]);
  }

  private loadCurrentWorkspaceRecord(): WindowRecord {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const folderPath = workspaceFolder?.uri.fsPath;
    return {
      title: vscode.window.activeTextEditor?.document.fileName
        ? path.basename(vscode.window.activeTextEditor.document.fileName)
        : 'Current Workspace',
      path: folderPath,
      uri: workspaceFolder?.uri.toString(),
      lastActive: Date.now(),
      source: 'vscode',
      status: 'focused',
    };
  }

  private async loadTrackerFiles(): Promise<WindowRecord[]> {
    if (!this.tracker) {
      this.tracker = new TrackerService(this.context, { fs: this.fsImpl });
    }
    try {
      const raw = await this.tracker.readTrackedRecords();
      return (raw as WindowRecord[]) || [];
    } catch {
      return [];
    }
  }

  private dedupe(records: WindowRecord[]): WindowRecord[] {
    const map = new Map<string, WindowRecord>();
    for (const record of records) {
      const keys = this.buildDedupKeys(record);
      const winnerKey = keys.find(key => map.has(key));
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

  /**
   * @docs isSaved
   * 判断给定的 `fsPath` 是否在保存集合中。
   */
  public isSaved(fsPath: string): boolean {
    return this.savedSvc.isSaved(fsPath);
  }

  /**
   * @docs save
   * 将给定 `fsPath` 添加到保存集合并持久化。
   */
  public async save(fsPath: string): Promise<void> {
    await this.savedSvc.save(fsPath);
  }

  /**
   * @docs removeSaved
   * 从保存集合移除给定 `fsPath` 并持久化。
   */
  public async removeSaved(fsPath: string): Promise<void> {
    await this.savedSvc.remove(fsPath);
  }

  /**
   * @docs getAllSaved
   * 返回保存集合的所有元素数组。
   */
  public getAllSaved(): string[] {
    return this.savedSvc.getAllSaved();
  }

  /**
   * @docs normalizeTrackedNodes
   * 将原始 `WindowRecord` 列表转换为用于 UI 的 `WindowNode` 数组并排序。
   */
  public normalizeTrackedNodes(records: WindowRecord[]): WindowNode[] {
    const now = Date.now();
    const enriched: WindowNode[] = records.map((record, index) => {
      const stableId =
        (buildDedupKeys(record) || [])[0] || `${record.path || record.title || 'window'}-${index}`;
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

  /**
   * @docs getWindowNodes
   * 合并并返回树视图所需的完整节点列表（已保存 + 跟踪）。
   */
  public async getWindowNodes(): Promise<WindowNode[]> {
    const loaded = await this.loadAllRecords();
    const trackedNodes = this.normalizeTrackedNodes(loaded);
    
    // 建立 ID -> 节点映射。优先使用 dirUri.fsPath，其次是 stableId。
    // 过滤掉没有有效标识符的记录，防止 map 冲突导致 UI 状态标记错误。
    const trackedById = new Map<string, WindowNode>();
    for (const n of trackedNodes) {
      const key = n.dirUri?.fsPath || n.stableId;
      if (key) {
        trackedById.set(key, n);
      }
    }

    let addedNodes = await this.savedSvc.buildSavedNodes();
    const savedLastActiveUpdates: SavedItem[] = [];
    const standaloneAdded: WindowNode[] = [];
    for (const a of addedNodes) {
      const key = a.dirUri?.fsPath || a.stableId;
      const t = key ? trackedById.get(key) : undefined;
      if (t) {
        t.isSaved = true;
        if (
          t.status === 'focused' &&
          typeof t.lastActive === 'number' &&
          t.lastActive > (a.lastActive ?? 0)
        ) {
          savedLastActiveUpdates.push({ id: a.stableId, lastActive: t.lastActive });
        }
      } else {
        standaloneAdded.push(a);
      }
    }
    addedNodes = standaloneAdded;
    if (savedLastActiveUpdates.length > 0) {
      await this.savedSvc.updateLastActiveBatch(savedLastActiveUpdates);
    }
    const nodes = [...trackedNodes, ...addedNodes].sort((a, b) => {
      if (a.origin !== b.origin) {
        return a.origin === 'tracked' ? -1 : 1;
      }
      return (b.lastActive ?? 0) - (a.lastActive ?? 0);
    });
    return nodes;
  }

  /**
   * @docs startTracker
   * 启动内部的 `TrackerService` 开始心跳写入。
   */
  public startTracker(): void {
    if (!this.tracker) {
      this.tracker = new TrackerService(this.context, { fs: this.fsImpl });
    }
    this.tracker.start();
  }

  /**
   * @docs stopTracker
   * 停止并清理内部的 `TrackerService`。
   */
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
  md.appendMarkdown(
    `- lastActive: ${node.lastActive ? new Date(node.lastActive).toLocaleString() : '-'}\n`
  );
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
export function getNodeIcon(
  node: WindowNode,
  isCurrentWorkspace: boolean,
  dataManager: DataManager
): vscode.ThemeIcon {
  const added =
    typeof node.isSaved === 'boolean' ? node.isSaved : dataManager.isSaved(node.stableId);
  if (isCurrentWorkspace) {
    return new vscode.ThemeIcon('repo', new vscode.ThemeColor('charts.blue'));
  }
  if (node.origin === 'tracked') {
    return new vscode.ThemeIcon('repo');
  }
  return added
    ? new vscode.ThemeIcon('database')
    : new vscode.ThemeIcon('repo', new vscode.ThemeColor('disabledForeground'));
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
