import * as path from 'path';
import * as vscode from 'vscode';
import { EditorTracker } from './editorTracker';
import { toRelativeTime } from './helpers';

/** 关闭动作枚举 */
type CloseActionId =
  | 'close-active-tab'
  | 'close-others-in-group'
  | 'close-active-group'
  | 'close-other-groups'
  | 'keep-only-active-tab'
  | 'close-all';

interface EditorQuickPickItem extends vscode.QuickPickItem {
  _kind: 'action' | 'tab';
  tabRef?: vscode.Tab;
  actionId?: CloseActionId;
}

/**
 * @docs getTabUriKey
 * 获取标签页对应的 URI 字符串，用于追踪最后活跃时间。
 * 终端等不支持的类型返回 undefined。
 */
export function getTabUriKey(tab: vscode.Tab): string | undefined {
  if (tab.input instanceof vscode.TabInputText) return tab.input.uri.toString();
  if (tab.input instanceof vscode.TabInputNotebook) return tab.input.uri.toString();
  if (tab.input instanceof vscode.TabInputCustom) return tab.input.uri.toString();
  if (tab.input instanceof vscode.TabInputTextDiff) return tab.input.modified.toString();
  return undefined;
}

/**
 * @docs getTabUri
 * 获取标签页对应的主 URI（Diff 类型取 modified 端）。
 */
export function getTabUri(tab: vscode.Tab): vscode.Uri | undefined {
  if (tab.input instanceof vscode.TabInputText) return tab.input.uri;
  if (tab.input instanceof vscode.TabInputNotebook) return tab.input.uri;
  if (tab.input instanceof vscode.TabInputCustom) return tab.input.uri;
  if (tab.input instanceof vscode.TabInputTextDiff) return tab.input.modified;
  return undefined;
}

/**
 * @docs getTabIcon
 * 根据标签输入类型返回合适的 ThemeIcon。
 */
export function getTabIcon(tab: vscode.Tab): vscode.ThemeIcon {
  if (tab.input instanceof vscode.TabInputText) return new vscode.ThemeIcon('file-code');
  if (tab.input instanceof vscode.TabInputNotebook) return new vscode.ThemeIcon('notebook');
  if (tab.input instanceof vscode.TabInputCustom) return new vscode.ThemeIcon('file-binary');
  if (tab.input instanceof vscode.TabInputTextDiff) return new vscode.ThemeIcon('diff');
  if (tab.input instanceof vscode.TabInputTerminal) return new vscode.ThemeIcon('terminal');
  return new vscode.ThemeIcon('file');
}

/**
 * @docs getTabRelativePath
 * 获取标签页文件相对于工作区根目录的路径；无法解析时返回绝对路径，终端等返回空串。
 */
export function getTabRelativePath(tab: vscode.Tab): string {
  const uri = getTabUri(tab);
  if (!uri) return '';
  const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (wsFolder) {
    return path.relative(wsFolder.uri.fsPath, uri.fsPath);
  }
  return uri.fsPath;
}

/**
 * @docs focusTab
 * 切换到指定标签页。支持文本、Notebook、自定义编辑器和 Diff 视图；
 * 终端等类型无法通过 API 直接切换，静默忽略。
 */
export async function focusTab(tab: vscode.Tab): Promise<void> {
  const vc = tab.group.viewColumn;
  if (tab.input instanceof vscode.TabInputText) {
    await vscode.window.showTextDocument(tab.input.uri, {
      viewColumn: vc,
      preserveFocus: false,
    });
  } else if (tab.input instanceof vscode.TabInputNotebook) {
    await vscode.commands.executeCommand('vscode.openWith', tab.input.uri, 'jupyter-notebook', {
      viewColumn: vc,
    });
  } else if (tab.input instanceof vscode.TabInputCustom) {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      tab.input.uri,
      tab.input.viewType,
      { viewColumn: vc }
    );
  } else if (tab.input instanceof vscode.TabInputTextDiff) {
    await vscode.commands.executeCommand(
      'vscode.diff',
      tab.input.original,
      tab.input.modified,
      tab.label,
      { viewColumn: vc }
    );
  }
}

/**
 * @docs executeCloseAction
 * 执行指定的关闭动作。
 * 使用 QuickPick 打开时快照的 activeTab / activeGroup，避免关闭期间状态漂移。
 */
async function executeCloseAction(
  actionId: CloseActionId,
  activeTabAtOpen: vscode.Tab | undefined,
  activeGroupAtOpen: vscode.TabGroup | undefined
): Promise<void> {
  const groups = vscode.window.tabGroups.all;

  switch (actionId) {
    case 'close-active-tab': {
      if (activeTabAtOpen) {
        await vscode.window.tabGroups.close(activeTabAtOpen);
      }
      break;
    }
    case 'close-others-in-group': {
      if (!activeGroupAtOpen || !activeTabAtOpen) break;
      const others = activeGroupAtOpen.tabs.filter(t => t !== activeTabAtOpen);
      if (others.length > 0) {
        await vscode.window.tabGroups.close(others);
      }
      break;
    }
    case 'close-active-group': {
      if (activeGroupAtOpen) {
        await vscode.window.tabGroups.close(activeGroupAtOpen);
      }
      break;
    }
    case 'close-other-groups': {
      if (!activeGroupAtOpen) break;
      const otherGroups = groups.filter(g => g !== activeGroupAtOpen);
      if (otherGroups.length > 0) {
        await vscode.window.tabGroups.close(otherGroups);
      }
      break;
    }
    case 'keep-only-active-tab': {
      if (!activeTabAtOpen) break;
      const toClose = groups.flatMap(g => g.tabs).filter(t => t !== activeTabAtOpen);
      if (toClose.length > 0) {
        await vscode.window.tabGroups.close(toClose);
      }
      break;
    }
    case 'close-all': {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      break;
    }
  }
}

/**
 * @docs openEditorsQuickPick
 * 打开编辑器标签页 QuickPick（Phase 1 主入口）。
 *
 * 功能：
 * - 按编辑器组分组展示所有标签页，支持按文件名/路径过滤
 * - 提供快捷关闭操作（关闭当前/组/其他组/全部/仅保留当前）
 * - 每个标签页行内有 × 按钮可单独关闭
 * - 选中标签页后切换过去（跨组支持）
 */
export function openEditorsQuickPick(tracker: EditorTracker): void {
  // 在打开 QuickPick 前捕获活跃状态，避免 QuickPick 获焦后状态漂移
  const activeGroupAtOpen = vscode.window.tabGroups.activeTabGroup;
  const activeTabAtOpen = activeGroupAtOpen.activeTab;

  function buildItems(): EditorQuickPickItem[] {
    const items: EditorQuickPickItem[] = [];
    const groups = vscode.window.tabGroups.all;
    const totalTabs = groups.reduce((s, g) => s + g.tabs.length, 0);
    const hasMultipleGroups = groups.length > 1;
    const activeLabel = activeTabAtOpen?.label ?? '';

    // ─── 关闭操作区 ───
    items.push({
      _kind: 'action',
      label: '关闭操作',
      kind: vscode.QuickPickItemKind.Separator,
    });

    if (activeTabAtOpen) {
      items.push({
        _kind: 'action',
        actionId: 'close-active-tab',
        label: '$(close) 关闭当前标签页',
        description: activeLabel,
        alwaysShow: true,
      });
    }

    const othersInGroupCount =
      (activeGroupAtOpen?.tabs.length ?? 0) - (activeTabAtOpen ? 1 : 0);
    if (othersInGroupCount > 0) {
      items.push({
        _kind: 'action',
        actionId: 'close-others-in-group',
        label: '$(trash) 关闭当前组的其他标签页',
        description: `保留 ${activeLabel}，关闭其余 ${othersInGroupCount} 个`,
        alwaysShow: true,
      });
    }

    if (activeGroupAtOpen && activeGroupAtOpen.tabs.length > 0) {
      items.push({
        _kind: 'action',
        actionId: 'close-active-group',
        label: '$(split-horizontal) 关闭当前编辑器组',
        description: `组内共 ${activeGroupAtOpen.tabs.length} 个标签`,
        alwaysShow: true,
      });
    }

    if (hasMultipleGroups) {
      items.push({
        _kind: 'action',
        actionId: 'close-other-groups',
        label: '$(window) 关闭其他编辑器组',
        description: `保留当前组，关闭其他 ${groups.length - 1} 个组`,
        alwaysShow: true,
      });
      items.push({
        _kind: 'action',
        actionId: 'keep-only-active-tab',
        label: '$(record) 仅保留当前标签页',
        description: '关闭所有其他标签页及编辑器组',
        alwaysShow: true,
      });
    }

    if (totalTabs > 0) {
      items.push({
        _kind: 'action',
        actionId: 'close-all',
        label: '$(close-all) 关闭全部标签页',
        description: `共 ${totalTabs} 个标签`,
        alwaysShow: true,
      });
    }

    // ─── 标签页列表（按组分组） ───
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const isActiveGroup = group.isActive;
      const groupLabel = `编辑器组 ${gi + 1}${isActiveGroup ? '  ●' : ''}`;

      items.push({
        _kind: 'action',
        label: groupLabel,
        kind: vscode.QuickPickItemKind.Separator,
      });

      for (const tab of group.tabs) {
        const uriKey = getTabUriKey(tab);
        const lastActive = uriKey ? tracker.getLastActive(uriKey) : undefined;
        const timeLabel = lastActive ? toRelativeTime(lastActive) : '';

        const isActiveTab = tab.isActive && isActiveGroup;
        const relPath = getTabRelativePath(tab);
        const dir = relPath ? path.dirname(relPath) : '';

        const descParts: string[] = [];
        if (dir && dir !== '.') descParts.push(dir);
        if (timeLabel) descParts.push(timeLabel);
        if (tab.isPinned) descParts.push('📌');
        if (tab.isPreview) descParts.push('预览');
        if (tab.isDirty) descParts.push('$(circle-filled)');

        items.push({
          _kind: 'tab',
          tabRef: tab,
          label: `${isActiveTab ? '$(record) ' : ''}${tab.label}`,
          description: descParts.join('  ·  '),
          iconPath: getTabIcon(tab),
          buttons: [
            {
              iconPath: new vscode.ThemeIcon('close'),
              tooltip: '关闭此标签页',
            },
          ],
        });
      }
    }

    return items;
  }

  const qp = vscode.window.createQuickPick<EditorQuickPickItem>();
  qp.placeholder = '输入文件名快速定位标签页 · Enter 切换 · 右侧 × 关闭单个标签';
  qp.matchOnDescription = true;
  qp.items = buildItems();

  const disposables: vscode.Disposable[] = [];

  // 点击标签行内的 × 按钮，关闭该标签并刷新列表
  disposables.push(
    qp.onDidTriggerItemButton(async event => {
      if (event.item._kind !== 'tab' || !event.item.tabRef) return;
      await vscode.window.tabGroups.close(event.item.tabRef);
      qp.items = buildItems();
    }),

    qp.onDidAccept(async () => {
      const picked = qp.selectedItems[0];
      if (!picked) return;
      qp.hide();

      if (picked._kind === 'action' && picked.actionId) {
        await executeCloseAction(picked.actionId, activeTabAtOpen, activeGroupAtOpen);
        return;
      }

      if (picked._kind === 'tab' && picked.tabRef) {
        await focusTab(picked.tabRef);
      }
    }),

    qp.onDidHide(() => {
      disposables.forEach(d => d.dispose());
      qp.dispose();
    })
  );

  qp.show();
}
