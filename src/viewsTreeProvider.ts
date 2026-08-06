import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// globalState 键沿用旧的 viewsNavigator 前缀，保证已存数据（置顶/隐藏/备注/过滤状态）不丢失
const PINNED_KEY = 'viewsNavigator:pinned';
const HIDDEN_KEY = 'viewsNavigator:hidden';
const NOTES_KEY = 'viewsNavigator:notes';
const FILTER_HIDDEN_KEY = 'viewsNavigator:filterHidden';

// ─── 类型 ───

export interface ViewDef {
  id: string;
  name: string;
  icon?: string;
  extension?: string; // undefined = 内置
}

export type GroupNode = {
  type: 'group';
  groupType: 'builtin' | 'extension';
  label: string;
  extensionName?: string;
};

export type ViewNode = {
  type: 'view';
  viewDef: ViewDef;
  isPinned: boolean;
  isHidden: boolean;
};

export type ViewsNode = GroupNode | ViewNode;

// ─── 内置视图 ───

const BUILTIN_VIEWS: ViewDef[] = [
  { id: 'workbench.view.explorer', name: 'Explorer', icon: 'files' },
  { id: 'workbench.view.search', name: 'Search', icon: 'search' },
  { id: 'workbench.view.scm', name: 'Source Control', icon: 'source-control' },
  { id: 'workbench.view.debug', name: 'Run and Debug', icon: 'debug-alt' },
  { id: 'workbench.view.extensions', name: 'Extensions', icon: 'extensions' },
  { id: 'workbench.view.testing', name: 'Testing', icon: 'beaker' },
  { id: 'outline', name: 'Outline', icon: 'list-tree' },
  { id: 'timeline', name: 'Timeline', icon: 'history' },
];

// ─── Provider ───

export class ViewsTreeProvider implements vscode.TreeDataProvider<ViewsNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ViewsNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private allViews: ViewDef[] = [];
  private duplicateNames = new Set<string>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  // ─── 公开 API ───

  async refresh(): Promise<void> {
    const extViews = await this._scanExtensionViews();
    this.allViews = this._mergeViews(extViews);
    this.duplicateNames = this._detectDuplicateNames(this.allViews);
    this._onDidChangeTreeData.fire(undefined);
  }

  getPinned(): string[] {
    return this.context.globalState.get<string[]>(PINNED_KEY, []);
  }

  async togglePin(viewId: string): Promise<boolean> {
    const pinned = this.getPinned();
    const idx = pinned.indexOf(viewId);
    const next = idx >= 0 ? pinned.filter(id => id !== viewId) : [...pinned, viewId];
    await this.context.globalState.update(PINNED_KEY, next);
    this._onDidChangeTreeData.fire(undefined);
    return idx < 0;
  }

  getHidden(): string[] {
    return this.context.globalState.get<string[]>(HIDDEN_KEY, []);
  }

  async toggleHidden(viewId: string): Promise<boolean> {
    const hidden = this.getHidden();
    const idx = hidden.indexOf(viewId);
    const next = idx >= 0 ? hidden.filter(id => id !== viewId) : [...hidden, viewId];
    await this.context.globalState.update(HIDDEN_KEY, next);
    this._onDidChangeTreeData.fire(undefined);
    return idx < 0;
  }

  getNotes(): Record<string, string> {
    return this.context.globalState.get<Record<string, string>>(NOTES_KEY, {});
  }

  async setNote(viewId: string, note: string): Promise<void> {
    const notes = this.getNotes();
    if (note) {
      notes[viewId] = note;
    } else {
      delete notes[viewId];
    }
    await this.context.globalState.update(NOTES_KEY, notes);
    this._onDidChangeTreeData.fire(undefined);
  }

  isFilterHidden(): boolean {
    return this.context.globalState.get<boolean>(FILTER_HIDDEN_KEY, false);
  }

  async toggleFilterHidden(): Promise<boolean> {
    const next = !this.isFilterHidden();
    await this.context.globalState.update(FILTER_HIDDEN_KEY, next);
    this._onDidChangeTreeData.fire(undefined);
    return next;
  }

  getViewName(viewId: string): string {
    return this.allViews.find(v => v.id === viewId)?.name || viewId;
  }

  // ─── TreeDataProvider ───

  getTreeItem(element: ViewsNode): vscode.TreeItem {
    if (element.type === 'group') {
      return this._buildGroupItem(element);
    }
    return this._buildViewItem(element);
  }

  getChildren(element?: ViewsNode): ViewsNode[] {
    if (!element) {
      return this._buildRootGroups();
    }
    if (element.type === 'group') {
      return this._buildViewNodes(element);
    }
    return [];
  }

  // ─── 扫描扩展 ───

  private async _scanExtensionViews(): Promise<ViewDef[]> {
    const results: ViewDef[] = [];
    const isInsiders = vscode.env.appName.includes('Insiders');
    const codeDir = isInsiders ? '.vscode-insiders' : '.vscode';
    const extensionsDir = path.join(os.homedir(), codeDir, 'extensions');

    let entries: string[] = [];
    try {
      entries = await fs.readdir(extensionsDir);
    } catch {
      return results;
    }

    for (const entry of entries) {
      const extPath = path.join(extensionsDir, entry);
      const pkgPath = path.join(extPath, 'package.json');
      try {
        const stat = await fs.stat(extPath);
        if (!stat.isDirectory()) continue;

        const pkgRaw = await fs.readFile(pkgPath, 'utf8');
        const pkg = JSON.parse(pkgRaw) as {
          name?: string;
          displayName?: string;
          contributes?: {
            views?: Record<string, Array<{ id?: string; name?: string }>>;
          };
        };

        const viewsMap = pkg.contributes?.views;
        if (!viewsMap) continue;

        const extName = pkg.displayName || pkg.name || entry;

        for (const views of Object.values(viewsMap)) {
          for (const view of views) {
            if (!view.id) continue;
            const viewName = view.name || view.id;
            if (viewName.includes('%') || extName.includes('%')) continue;
            results.push({
              id: view.id,
              name: viewName,
              extension: extName,
            });
          }
        }
      } catch {
        // ignore
      }
    }

    return results;
  }

  // ─── 合并 + 去重 + 重名 ───

  private _mergeViews(extViews: ViewDef[]): ViewDef[] {
    const all = [...BUILTIN_VIEWS, ...extViews];
    const seen = new Set<string>();
    return all.filter(v => {
      if (seen.has(v.id)) return false;
      seen.add(v.id);
      return true;
    });
  }

  private _detectDuplicateNames(views: ViewDef[]): Set<string> {
    const count = new Map<string, number>();
    for (const v of views) count.set(v.name, (count.get(v.name) || 0) + 1);
    const dups = new Set<string>();
    for (const [name, c] of count) if (c > 1) dups.add(name);
    return dups;
  }

  // ─── 构建节点 ───

  private _buildRootGroups(): GroupNode[] {
    const hidden = this.getHidden();
    const filterHidden = this.isFilterHidden();

    const groups: GroupNode[] = [];

    const builtinViews = this.allViews.filter(v => BUILTIN_VIEWS.some(b => b.id === v.id));
    const extViews = this.allViews.filter(v => v.extension && !BUILTIN_VIEWS.some(b => b.id === v.id));

    const hasBuiltin = filterHidden
      ? builtinViews.some(v => hidden.includes(v.id))
      : builtinViews.length > 0;

    if (hasBuiltin) {
      groups.push({ type: 'group', groupType: 'builtin', label: '内置视图' });
    }

    const extNames = [...new Set(extViews.map(v => v.extension!))].sort();
    for (const name of extNames) {
      const viewsInExt = extViews.filter(v => v.extension === name);
      const shouldShow = filterHidden
        ? viewsInExt.some(v => hidden.includes(v.id))
        : viewsInExt.length > 0;
      if (shouldShow) {
        groups.push({ type: 'group', groupType: 'extension', label: name, extensionName: name });
      }
    }

    return groups;
  }

  private _buildViewNodes(group: GroupNode): ViewNode[] {
    const pinned = this.getPinned();
    const hidden = this.getHidden();
    const filterHidden = this.isFilterHidden();

    const makeNode = (v: ViewDef): ViewNode => ({
      type: 'view' as const,
      viewDef: v,
      isPinned: pinned.includes(v.id),
      isHidden: hidden.includes(v.id),
    });

    const shouldInclude = (v: ViewDef): boolean => {
      if (!filterHidden) return true;
      return hidden.includes(v.id);
    };

    switch (group.groupType) {
      case 'builtin': {
        const builtinIds = new Set(BUILTIN_VIEWS.map(b => b.id));
        return this.allViews
          .filter(v => builtinIds.has(v.id) && shouldInclude(v))
          .map(makeNode);
      }
      case 'extension':
        return this.allViews
          .filter(v => v.extension === group.extensionName && !BUILTIN_VIEWS.some(b => b.id === v.id) && shouldInclude(v))
          .map(makeNode);
    }
  }

  // ─── 构建 TreeItem ───

  private _buildGroupItem(node: GroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `group:${node.groupType}:${node.extensionName || ''}`;
    item.iconPath = new vscode.ThemeIcon(
      node.groupType === 'builtin' ? 'vm' : 'extensions'
    );
    return item;
  }

  private _buildViewItem(node: ViewNode): vscode.TreeItem {
    const v = node.viewDef;
    const hasDup = this.duplicateNames.has(v.name);

    const item = new vscode.TreeItem(v.name, vscode.TreeItemCollapsibleState.None);
    item.id = `view:${v.id}`;

    // 图标
    if (v.icon) {
      item.iconPath = new vscode.ThemeIcon(v.icon);
    } else {
      item.iconPath = new vscode.ThemeIcon('window');
    }

    // Description：状态标记 + 重名 viewId + 扩展名 + 备注
    // 注意：TreeView 的 label/description 不渲染 $(icon) codicon 语法，状态用 emoji 表示
    const descParts: string[] = [];
    if (node.isPinned) descParts.push('📌');
    if (node.isHidden) descParts.push('🙈');
    if (hasDup) descParts.push(v.id);
    if (v.extension && !BUILTIN_VIEWS.some(b => b.id === v.id)) descParts.push(v.extension);
    const note = this.getNotes()[v.id];
    if (note) descParts.push(`📝 ${note}`);
    item.description = descParts.join(' · ');

    // Tooltip
    const tooltipParts = [`ID: ${v.id}`];
    if (v.extension) tooltipParts.push(`扩展: ${v.extension}`);
    if (note) tooltipParts.push(`📝 备注: ${note}`);
    if (node.isPinned) tooltipParts.push('📌 已置顶（QuickPick 优先展示）');
    if (node.isHidden) tooltipParts.push('👁‍🗨 已在 QuickPick 中隐藏');
    item.tooltip = new vscode.MarkdownString(tooltipParts.join('  \n'));

    // Context value 驱动行内按钮
    const parts = ['viewsItem'];
    if (node.isPinned) parts.push('pinned');
    if (node.isHidden) parts.push('hidden');
    item.contextValue = parts.join(':');

    // 单击整行即聚焦该视图（与行内 reveal 按钮同一命令）
    item.command = {
      command: 'vscode-window-tracker.focusView',
      title: '聚焦视图',
      arguments: [node],
    };

    return item;
  }
}
