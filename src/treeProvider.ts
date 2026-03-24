import * as vscode from 'vscode';
import { createDataManager } from './dataManager';
import { ConfigService } from './configService';
const configService = ConfigService.getInstance();
import { SavedColor, WindowNode } from './types';
import {
  formatTitle,
  buildDescription,
  buildTooltip,
  buildContextValue,
  getNodeIcon,
  isCurrentWorkspace,
} from './dataManager';

export class WindowTreeDataProvider implements vscode.TreeDataProvider<WindowNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<WindowNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private nodes: WindowNode[] = [];
  private dataManager: ReturnType<typeof createDataManager>;
  private lastHash = '';

  constructor(private readonly context: vscode.ExtensionContext) {
    this.dataManager = createDataManager(this.context);
  }

  /**
   * @docs startHeartbeat
   * 启动 view 的心跳刷新机制（基于配置的间隔）。
   */
  public startHeartbeat(context: vscode.ExtensionContext): void {
    void this.refresh();
    const interval = configService.heartbeatIntervalSeconds * 1000;
    const timer = setInterval(() => {
      void this.refresh();
    }, interval);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  /**
   * @docs addProjectByNode
   * 根据节点或选择的文件夹添加项目到保存列表。
   */
  public async addProjectByNode(node?: WindowNode): Promise<void> {
    let targetUri = node?.dirUri;
    if (!targetUri) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
      });
      if (!picked || picked.length === 0) {
        return;
      }
      targetUri = picked[0];
    }
    await this.dataManager.save(targetUri.fsPath);

    void this.refresh(true);
  }

  /**
   * @docs removeProjectById
   * 从保存列表中移除指定 `stableId` 并刷新视图。
   */
  public async removeProjectById(stableId: string): Promise<void> {
    await this.dataManager.removeSaved(stableId);
    void this.refresh(true);
  }

  /**
   * @docs editProjectByNode
   * 点击树节点后按步骤编辑展示名和基础颜色。
   */
  public async editProjectByNode(node?: WindowNode): Promise<void> {
    if (!node || node.stableId === 'placeholder-no-data') {
      return;
    }

    const savedId = this.dataManager.resolveNodeSavedId(node);
    if (!savedId) {
      return;
    }

    const displayName = await vscode.window.showInputBox({
      title: `编辑项目: ${formatTitle(node)}`,
      prompt: '第一步：输入展示名。留空表示不配置展示名',
      value: node.displayName || '',
      ignoreFocusOut: true,
    });
    if (displayName === undefined) {
      return;
    }

    const color = await pickColor(node.color);
    if (color === undefined) {
      return;
    }

    await this.dataManager.upsertSavedMetadata(savedId, {
      displayName: displayName.trim() || undefined,
      color,
    });
    void this.refresh(true);
  }

  /**
   * @docs refresh
   * 刷新树数据，必要时触发视图更新。
   */
  public async refresh(force = false): Promise<void> {
    this.nodes = await this.dataManager.getWindowNodes();
    const hash = JSON.stringify(
      this.nodes.map(item => ({
        id: item.stableId,
        relativeActive: item.relativeActive,
        path: item.path,
        title: item.title,
      }))
    );
    if (force || hash !== this.lastHash) {
      this.lastHash = hash;
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  /**
   * @docs getTreeItem
   * 将 `WindowNode` 转换为 VS Code 的 `TreeItem` 表示。
   */
  public getTreeItem(element: WindowNode): vscode.TreeItem {
    const title = formatTitle(element);
    const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
    item.id = `${element.origin}:${element.stableId}`;
    const current = isCurrentWorkspace(element.path, element.uri);
    item.iconPath = getNodeIcon(element, current, this.dataManager);
    item.description = buildDescription(element);
    item.tooltip = buildTooltip(element);
    const baseContext = buildContextValue(element);
    item.contextValue = current ? `${baseContext}:current` : baseContext;
    try {
      if (element.origin === 'saved') {
        console.debug(`[vscode-window-tracker] contextValue for ${item.id}: ${item.contextValue}`);
      }
    } catch {}
    if (current) {
      item.label = { label: title, highlights: [[0, title.length]] };
    }
    item.accessibilityInformation = {
      label: `${title}, ${element.relativeActive}`,
      role: 'treeitem',
    };
    return item;
  }

  /**
   * @docs getChildren
   * 返回给定节点的子节点（无节点则返回根节点列表或占位项）。
   */
  public async getChildren(element?: WindowNode): Promise<WindowNode[]> {
    if (!element) {
      if (this.nodes.length === 0) {
        return [
          {
            type: 'window',
            stableId: 'placeholder-no-data',
            title: 'No tracked windows',
            path: undefined,
            uri: undefined,
            pid: undefined,
            windowId: undefined,
            lastActive: Date.now(),
            source: 'none',
            status: 'idle',

            origin: 'tracked',
            dirUri: undefined,
            relativeActive: 'now',
          },
        ];
      }
      return this.nodes;
    }
    return [];
  }
}

function describeColor(color?: SavedColor): string {
  return color ? colorLabelMap[color] : '未设置';
}

async function pickColor(current?: SavedColor): Promise<SavedColor | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: '不配置颜色',
        description: current ? `当前颜色：${colorLabelMap[current]}` : '保持为空',
        value: null,
      },
      ...Object.entries(colorLabelMap).map(([value, label]) => ({
        label,
        description: value === current ? '当前颜色' : undefined,
        value: value as SavedColor,
      })),
    ],
    {
      title: '第二步：设置颜色',
      placeHolder: '选择一个基础颜色；选“不配置颜色”表示清空',
      ignoreFocusOut: true,
    }
  );
  if (!picked) {
    return undefined;
  }
  return picked.value ?? undefined;
}

const colorLabelMap: Record<SavedColor, string> = {
  blue: '蓝色',
  green: '绿色',
  yellow: '黄色',
  orange: '橙色',
  red: '红色',
  pink: '粉色',
  purple: '紫色',
  cyan: '青色',
  gray: '灰色',
};
