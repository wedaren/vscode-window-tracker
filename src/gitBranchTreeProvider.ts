import * as vscode from 'vscode';
import { GitService, BranchInfo } from './gitService';
import { toRelativeTime } from './helpers';

// ─── 节点类型 ───

export type BranchGroupNode = {
  type: 'group';
  groupType: 'local' | 'remote';
};

export type BranchItemNode = {
  type: 'branch';
  info: BranchInfo;
  repoRoot: string;
};

export type InfoNode = {
  type: 'info';
  message: string;
};

export type BranchTreeNode = BranchGroupNode | BranchItemNode | InfoNode;

// ─── MRU 辅助（复用 QuickPick 中的 key 规则） ───

function mruKey(repoRoot: string): string {
  return `gitBranchMru:${repoRoot}`;
}

function readMru(context: vscode.ExtensionContext, repoRoot: string): string[] {
  return context.globalState.get<string[]>(mruKey(repoRoot), []);
}

// ─── Provider ───

export class GitBranchTreeProvider implements vscode.TreeDataProvider<BranchTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BranchTreeNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<BranchTreeNode | undefined> =
    this._onDidChangeTreeData.event;

  private localBranches: BranchInfo[] = [];
  private remoteBranches: BranchInfo[] = [];
  private currentRepoRoot?: string;
  private isGitRepo = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly gitSvc: GitService
  ) {}

  /**
   * @docs refresh
   * 重新解析当前目标仓库并加载分支数据，然后刷新视图。
   */
  public async refresh(): Promise<void> {
    const repoRoot = await this._resolveRepoRoot();

    if (!repoRoot) {
      this.isGitRepo = false;
      this.currentRepoRoot = undefined;
      this.localBranches = [];
      this.remoteBranches = [];
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    const changedRepo = this.currentRepoRoot !== repoRoot;
    this.currentRepoRoot = repoRoot;
    this.isGitRepo = true;

    try {
      this.localBranches = await this.gitSvc.getBranches(repoRoot);
    } catch {
      this.localBranches = [];
    }

    try {
      this.remoteBranches = await this.gitSvc.getRemoteBranches(repoRoot);
    } catch {
      this.remoteBranches = [];
    }

    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * @docs getRepoRoot
   * 返回当前目标仓库的根目录（供外部命令使用）。
   */
  public getRepoRoot(): string | undefined {
    return this.currentRepoRoot;
  }

  // ─── TreeDataProvider 接口 ───

  getTreeItem(element: BranchTreeNode): vscode.TreeItem {
    switch (element.type) {
      case 'group':
        return this._buildGroupItem(element);
      case 'branch':
        return this._buildBranchItem(element);
      case 'info':
        return this._buildInfoItem(element);
    }
  }

  getChildren(element?: BranchTreeNode): BranchTreeNode[] {
    if (!element) {
      // 根节点
      if (!this.isGitRepo) {
        return [{ type: 'info', message: '当前工作区不是 Git 仓库' }];
      }
      const groups: BranchTreeNode[] = [];
      if (this.localBranches.length > 0 || this.remoteBranches.length === 0) {
        groups.push({ type: 'group', groupType: 'local' });
      }
      if (this.remoteBranches.length > 0) {
        groups.push({ type: 'group', groupType: 'remote' });
      }
      if (groups.length === 0) {
        return [{ type: 'info', message: '未找到分支' }];
      }
      return groups;
    }

    if (element.type === 'group') {
      const repoRoot = this.currentRepoRoot;
      if (!repoRoot) return [];

      if (element.groupType === 'local') {
        const mru = readMru(this.context, repoRoot);
        const sorted = this._sortBranches(this.localBranches, mru);
        return sorted.map(b => ({ type: 'branch', info: b, repoRoot }));
      }

      if (element.groupType === 'remote') {
        return this.remoteBranches.map(b => ({ type: 'branch', info: b, repoRoot }));
      }
    }

    return [];
  }

  // ─── 内部构建方法 ───

  private _buildGroupItem(node: BranchGroupNode): vscode.TreeItem {
    const label = node.groupType === 'local' ? '本地分支' : '远程分支';
    const item = new vscode.TreeItem(
      label,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.id = `group:${node.groupType}`;
    item.iconPath = new vscode.ThemeIcon(
      node.groupType === 'local' ? 'git-branch' : 'cloud'
    );
    item.contextValue = `branchGroup:${node.groupType}`;
    return item;
  }

  private _buildBranchItem(node: BranchItemNode): vscode.TreeItem {
    const b = node.info;
    const label = b.name;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `branch:${b.name}`;

    // 图标：当前分支用 record，远程用 cloud，其他用 git-branch
    if (b.isCurrent) {
      item.iconPath = new vscode.ThemeIcon('record');
    } else if (b.isRemote) {
      item.iconPath = new vscode.ThemeIcon('cloud');
    } else {
      item.iconPath = new vscode.ThemeIcon('git-branch');
    }

    // Description：时间 + ahead/behind
    const descParts: string[] = [];
    if (b.lastCommitMs) {
      descParts.push(toRelativeTime(b.lastCommitMs));
    }
    if (b.isCurrent && (b.ahead > 0 || b.behind > 0)) {
      const ab: string[] = [];
      if (b.ahead > 0) ab.push(`↑${b.ahead}`);
      if (b.behind > 0) ab.push(`↓${b.behind}`);
      if (ab.length) descParts.push(ab.join(' '));
    }
    item.description = descParts.join(' · ');

    // Context value 驱动右键菜单
    if (b.isCurrent) {
      item.contextValue = 'branchItem:current';
    } else if (b.isRemote) {
      item.contextValue = 'branchItem:remote';
    } else {
      item.contextValue = 'branchItem:local';
    }

    // Tooltip：展示同 commit 的其他分支
    const tooltipParts: string[] = [];
    if (b.lastCommitMs) {
      tooltipParts.push(`最后提交: ${toRelativeTime(b.lastCommitMs)}`);
    }
    if (!b.isRemote && b.commitHash && this.localBranches.length > 0) {
      const siblings = this.localBranches
        .filter(x => x.commitHash === b.commitHash && x.name !== b.name)
        .map(x => x.name);
      if (siblings.length > 0) {
        const shown = siblings.slice(0, 2);
        const more = siblings.length > 2 ? ` 等 ${siblings.length} 个` : '';
        tooltipParts.push(`同 commit: ${shown.join(', ')}${more}`);
      }
    }
    if (tooltipParts.length > 0) {
      item.tooltip = new vscode.MarkdownString(tooltipParts.join('  \n'));
    }

    // TreeView 中不再通过点击节点直接切换，而是通过行内按钮明确操作
    // 保留 command 为 undefined，使点击仅选中/聚焦节点

    return item;
  }

  private _buildInfoItem(node: InfoNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('info');
    return item;
  }

  // ─── 排序 ───

  private _sortBranches(branches: BranchInfo[], mru: string[]): BranchInfo[] {
    const current = branches.find(b => b.isCurrent);
    const others = branches.filter(b => !b.isCurrent);

    const mruSet = new Set(mru);
    const withMru = others.filter(b => mruSet.has(b.name));
    const withoutMru = others.filter(b => !mruSet.has(b.name));

    withMru.sort((a, b) => mru.indexOf(a.name) - mru.indexOf(b.name));
    withoutMru.sort((a, b) => (b.lastCommitMs ?? 0) - (a.lastCommitMs ?? 0));

    const result = [...withMru, ...withoutMru];
    if (current) {
      result.unshift(current);
    }
    return result;
  }

  // ─── 仓库定位 ───

  private async _resolveRepoRoot(): Promise<string | undefined> {
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (activeDoc && !activeDoc.isUntitled) {
      const wsFolder = vscode.workspace.getWorkspaceFolder(activeDoc.uri);
      if (wsFolder) {
        const root = await this.gitSvc.getRepoRoot(wsFolder.uri.fsPath);
        if (root) return root;
      }
    }

    const firstFolder = vscode.workspace.workspaceFolders?.[0];
    if (firstFolder) {
      const root = await this.gitSvc.getRepoRoot(firstFolder.uri.fsPath);
      if (root) return root;
    }

    return undefined;
  }
}
