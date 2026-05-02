import * as vscode from 'vscode';
import { EditorTracker } from './editorTracker';
import { toRelativeTime } from './helpers';
import { getTabIcon, getTabUriKey, getTabRelativePath } from './editorsQuickPick';

/**
 * @docs EditorGroupNode
 * 树视图中代表一个编辑器组的节点。
 */
export type EditorGroupNode = {
  type: 'group';
  viewColumn: vscode.ViewColumn;
  /** 1-based 编组序号，用于展示 */
  groupIndex: number;
  isActive: boolean;
  tabCount: number;
};

/**
 * @docs EditorTabNode
 * 树视图中代表一个标签页的节点。
 */
export type EditorTabNode = {
  type: 'tab';
  tab: vscode.Tab;
  viewColumn: vscode.ViewColumn;
  /** 所属编组序号（1-based），继承自父 EditorGroupNode */
  groupIndex: number;
  /** 会话内最后活跃时间（毫秒），来自 EditorTracker */
  lastActive?: number;
};

export type EditorNode = EditorGroupNode | EditorTabNode;

/**
 * @docs EditorsTreeProvider
 * 编辑器组与标签页的只读树视图提供者（Phase 2）。
 *
 * 特性：
 * - 以编辑器组为父节点、标签页为子节点展示层级结构
 * - 自动监听 tabGroups 变化事件刷新视图
 * - 活跃组/活跃标签页以高亮方式区分
 * - 点击标签页节点触发 focusEditorTab 命令切换过去
 * - 上下文菜单支持关闭组、关闭其他组操作
 */
export class EditorsTreeProvider implements vscode.TreeDataProvider<EditorNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<EditorNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<EditorNode | undefined> =
    this._onDidChangeTreeData.event;

  constructor(
    private readonly tracker: EditorTracker,
    context: vscode.ExtensionContext
  ) {
    context.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs(() =>
        this._onDidChangeTreeData.fire(undefined)
      ),
      vscode.window.tabGroups.onDidChangeTabGroups(() =>
        this._onDidChangeTreeData.fire(undefined)
      )
    );
  }

  /**
   * @docs getTreeItem
   * 将 EditorNode 转换为 VS Code TreeItem。
   */
  getTreeItem(element: EditorNode): vscode.TreeItem {
    if (element.type === 'group') {
      return this._buildGroupItem(element);
    }
    return this._buildTabItem(element);
  }

  /**
   * @docs getChildren
   * 返回子节点：根节点返回所有编辑器组，编辑器组节点返回其标签页列表。
   */
  getChildren(element?: EditorNode): EditorNode[] {
    if (!element) {
      return this._buildGroupNodes();
    }
    if (element.type === 'group') {
      return this._buildTabNodes(element);
    }
    return [];
  }

  /**
   * @docs getParent
   * 返回标签页节点的父编辑器组节点，用于支持 reveal 操作。
   */
  getParent(element: EditorNode): EditorGroupNode | undefined {
    if (element.type !== 'tab') return undefined;
    const groups = vscode.window.tabGroups.all;
    const idx = groups.findIndex(g => g.viewColumn === element.viewColumn);
    if (idx < 0) return undefined;
    const g = groups[idx];
    return {
      type: 'group',
      viewColumn: g.viewColumn,
      groupIndex: idx + 1,
      isActive: g.isActive,
      tabCount: g.tabs.length,
    };
  }

  private _buildGroupNodes(): EditorGroupNode[] {
    return vscode.window.tabGroups.all.map((g, i) => ({
      type: 'group',
      viewColumn: g.viewColumn,
      groupIndex: i + 1,
      isActive: g.isActive,
      tabCount: g.tabs.length,
    }));
  }

  private _buildTabNodes(groupNode: EditorGroupNode): EditorTabNode[] {
    const group = vscode.window.tabGroups.all.find(
      g => g.viewColumn === groupNode.viewColumn
    );
    if (!group) return [];

    return group.tabs.map(tab => {
      const uriKey = getTabUriKey(tab);
      return {
        type: 'tab',
        tab,
        viewColumn: group.viewColumn,
        groupIndex: groupNode.groupIndex,
        lastActive: uriKey ? this.tracker.getLastActive(uriKey) : undefined,
      };
    });
  }

  private _buildGroupItem(node: EditorGroupNode): vscode.TreeItem {
    const label = `编辑器组 ${node.groupIndex}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `editorGroup:${node.viewColumn}`;
    item.iconPath = new vscode.ThemeIcon(node.isActive ? 'layout-activitybar-left' : 'layout');
    item.description = `${node.tabCount} 个标签页`;
    item.contextValue = node.isActive ? 'editorGroupItem:active' : 'editorGroupItem';
    item.tooltip = node.isActive
      ? new vscode.MarkdownString(`**编辑器组 ${node.groupIndex}**（活跃）\n\n${node.tabCount} 个标签页`)
      : new vscode.MarkdownString(`**编辑器组 ${node.groupIndex}**\n\n${node.tabCount} 个标签页`);
    return item;
  }

  private _buildTabItem(node: EditorTabNode): vscode.TreeItem {
    const tab = node.tab;
    const label = tab.label;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `editorTab:${node.viewColumn}:${getTabUriKey(tab) ?? tab.label}`;
    item.iconPath = getTabIcon(tab);

    const relPath = getTabRelativePath(tab);
    const descParts: string[] = [];
    if (relPath) descParts.push(relPath);
    if (node.lastActive) descParts.push(toRelativeTime(node.lastActive));
    if (tab.isPreview) descParts.push('预览');
    if (tab.isDirty) descParts.push('●');
    item.description = descParts.join('  ·  ');

    const isActive = tab.isActive;
    item.contextValue = isActive ? 'editorTabItem:active' : 'editorTabItem';
    if (isActive) {
      item.label = { label, highlights: [[0, label.length]] };
    }

    const tooltip = new vscode.MarkdownString(
      [relPath, node.lastActive ? `最后活跃：${toRelativeTime(node.lastActive)}` : ''].filter(Boolean).join('\n\n'),
      false
    );
    tooltip.isTrusted = false;
    item.tooltip = tooltip;

    // 点击节点切换到该标签页
    item.command = {
      command: 'vscode-window-tracker.focusEditorTab',
      title: '切换到此标签页',
      arguments: [node],
    };

    return item;
  }
}
