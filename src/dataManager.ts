import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigService } from './configService';
const configService = ConfigService.getInstance();
import { WindowNode, WindowRecord, SavedColor, SavedItem } from './types';
import { buildDedupKeys, toRelativeTime, formatKeybindingLabel } from './helpers';
import { TrackerService } from './trackerService';
import { SavedService } from './savedService';
import { GitService } from './gitService';

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
  private readonly gitSvc: GitService = new GitService();

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
   * @docs upsertSavedMetadata
   * 更新指定保存项的展示名与颜色；若不存在则自动创建。
   */
  public async upsertSavedMetadata(
    id: string,
    metadata: { displayName?: string; color?: SavedColor }
  ): Promise<void> {
    await this.savedSvc.upsertMetadata(id, metadata);
  }

  /**
   * @docs togglePinned
   * 切换指定 id 的置顶状态并持久化；返回新的置顶状态。
   */
  public async togglePinned(id: string): Promise<boolean> {
    return this.savedSvc.togglePinned(id);
  }

  /**
   * @docs togglePinnedTo
   * 将指定 id 的置顶状态设置为给定值并持久化。
   */
  public async togglePinnedTo(id: string, pinned: boolean): Promise<void> {
    await this.savedSvc.setPinned(id, pinned);
  }

  /**
   * @docs incrementOpenCount
   * 将指定保存项的使用次数加一并持久化。
   */
  public async incrementOpenCount(id: string): Promise<void> {
    await this.savedSvc.incrementOpenCount(id);
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
   * @docs resolveNodeSavedId
   * 解析节点对应的保存项 id，供编辑 saved.json 元数据使用。
   */
  public resolveNodeSavedId(node: WindowNode): string | undefined {
    return node.savedItemId || node.dirUri?.fsPath || node.path || node.uri || node.stableId;
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
        // 将 saved.json 中配置的 keybinding 合并到 tracked 节点，供 buildContextValue 使用
        if (a.keybinding) {
          t.keybinding = a.keybinding;
        }
        t.displayName = a.displayName;
        t.color = a.color;
        t.savedItemId = a.savedItemId || a.stableId;
        t.pinned = a.pinned;
        t.openCount = a.openCount;
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
      // 排序优先级：置顶(pinned) > 最近使用(lastActive) > 使用频率(openCount) > 重命名优先(displayName)
      const aPinned = a.pinned ? 1 : 0;
      const bPinned = b.pinned ? 1 : 0;
      if (bPinned !== aPinned) return bPinned - aPinned;
      const lastActiveDiff = (b.lastActive ?? 0) - (a.lastActive ?? 0);
      if (lastActiveDiff !== 0) return lastActiveDiff;
      const openCountDiff = (b.openCount ?? 0) - (a.openCount ?? 0);
      if (openCountDiff !== 0) return openCountDiff;
      const aRenamed = a.displayName ? 1 : 0;
      const bRenamed = b.displayName ? 1 : 0;
      return bRenamed - aRenamed;
    });

    // 异步填充每个节点的 git 文件变更信息（不阻塞主流程）
    await this.enrichNodesWithGitInfo(nodes);

    return nodes;
  }

  /**
   * @docs enrichNodesWithGitInfo
   * 为所有有路径的节点异步查询 git 工作区摘要，填充 lastFileChangeMs 与 recentChangedFiles。
   */
  private async enrichNodesWithGitInfo(nodes: WindowNode[]): Promise<void> {
    await Promise.all(
      nodes.map(async node => {
        const root = node.dirUri?.fsPath || node.path;
        if (!root) return;
        try {
          const summary = await this.gitSvc.getSummary(root);
          node.lastFileChangeMs = summary.lastChangeMs;
          node.recentChangedFiles = summary.changedFiles.map(f => f.relativePath);
        } catch {
          // 静默降级
        }
        try {
          node.currentBranch = await this.gitSvc.getCurrentBranch(root);
        } catch {
          // 静默降级
        }
      })
    );
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
  const originalTitle = getOriginalTitle(node);
  if (node.displayName) {
    return `${node.displayName} (${originalTitle})`;
  }
  return originalTitle;
}

function getOriginalTitle(node: WindowNode): string {
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
 * 格式：「[改: 文件变更时间 ·] 窗口活跃时间 [· 快捷键]」
 */
export function buildDescription(node: WindowNode): string {
  const parts: string[] = [];

  if (node.pinned) {
    parts.push('$(pinned) 置顶');
  }

  if (typeof node.lastFileChangeMs === 'number') {
    const fileTime = toRelativeTime(node.lastFileChangeMs);
    // 只有与窗口活跃时间不同才追加，避免重复
    if (fileTime !== node.relativeActive) {
      parts.push(`改: ${fileTime}`);
    }
  }

  parts.push(node.relativeActive);

  if (node.keybinding) {
    parts.push(formatKeybindingLabel(node.keybinding));
  }

  return parts.join(' · ');
}

/**
 * 为项构建 Markdown 格式的提示信息。
 * 展示窗口基本信息、两种时间与 git 有变更文件列表。
 */
export function buildTooltip(node: WindowNode): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${formatTitle(node)}**\n\n`);

  // 时间信息
  md.appendMarkdown(`---\n\n`);
  if (node.lastActive) {
    md.appendMarkdown(`🕐 **窗口活跃**：${toRelativeTime(node.lastActive)} （${new Date(node.lastActive).toLocaleString()}）\n\n`);
  }
  if (typeof node.lastFileChangeMs === 'number') {
    md.appendMarkdown(`✏ **文件变更**：${toRelativeTime(node.lastFileChangeMs)} （${new Date(node.lastFileChangeMs).toLocaleString()}）\n\n`);
  }

  // git 有变更文件列表
  if (node.recentChangedFiles && node.recentChangedFiles.length > 0) {
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`**未提交变更文件**（staged / unstaged）\n\n`);
    const display = node.recentChangedFiles.slice(0, 10);
    for (const f of display) {
      md.appendMarkdown(`- \`${f}\`\n`);
    }
    if (node.recentChangedFiles.length > 10) {
      md.appendMarkdown(`- *…还有 ${node.recentChangedFiles.length - 10} 个文件*\n`);
    }
    md.appendMarkdown(`\n`);
  }

  // 基本信息
  md.appendMarkdown(`---\n\n`);
  md.appendMarkdown(`- path: ${node.path || '-'}\n`);
  md.appendMarkdown(`- pid: ${node.pid ?? '-'}\n`);
  md.appendMarkdown(`- source: ${node.source || '-'}\n`);
  if (node.keybinding) {
    md.appendMarkdown(`- keybinding: \`${node.keybinding}\`\n`);
  }
  md.isTrusted = false;
  return md;
}

/**
 * 用于菜单贡献的上下文值字符串。
 * 已保存且配置了 keybinding 时附加 `:kb`，供右键“验证快捷键”命令使用。
 */
export function buildContextValue(node: WindowNode): string {
  const kb = node.keybinding ? ':kb' : '';
  const pinned = node.pinned ? ':pinned' : '';
  if (node.origin === 'saved') {
    return `windowItem:saved${kb}${pinned}`;
  }
  if (node.origin === 'tracked') {
    if (node.isSaved) {
      return `windowItem:tracked:saved${kb}${pinned}`;
    }
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
  const color = getColorTheme(node.color);
  if (color) {
    const iconId = isCurrentWorkspace ? 'repo' : node.origin === 'tracked' ? 'repo' : 'database';
    return new vscode.ThemeIcon(iconId, color);
  }
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

function getColorTheme(color?: SavedColor): vscode.ThemeColor | undefined {
  switch (color) {
    case 'blue':
      return new vscode.ThemeColor('charts.blue');
    case 'green':
      return new vscode.ThemeColor('charts.green');
    case 'yellow':
      return new vscode.ThemeColor('charts.yellow');
    case 'orange':
      return new vscode.ThemeColor('charts.orange');
    case 'red':
      return new vscode.ThemeColor('charts.red');
    case 'pink':
      return new vscode.ThemeColor('charts.purple');
    case 'purple':
      return new vscode.ThemeColor('charts.purple');
    case 'cyan':
      return new vscode.ThemeColor('charts.blue');
    case 'gray':
      return new vscode.ThemeColor('descriptionForeground');
    default:
      return undefined;
  }
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
