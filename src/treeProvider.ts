import * as vscode from 'vscode';
import { createDataManager } from './dataManager';
import { ConfigService } from './configService';
const configService = ConfigService.getInstance();
import { WindowNode } from './types';
import { formatTitle, buildDescription, buildTooltip, buildContextValue, getNodeIcon, isCurrentWorkspace } from './dataManager';



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
	public async addProjectByNode(node?: WindowNode, dirUri?: vscode.Uri): Promise<void> {
		let targetUri = dirUri;
		if (!targetUri && node && node.dirUri) {
			targetUri = node.dirUri;
		}
		if (!targetUri) {
			const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
			if (!picked || picked.length === 0) {
				return;
			}
			targetUri = picked[0];
		}
		const stableId = node?.stableId ?? targetUri.toString();
		await this.dataManager.save(stableId);
		
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
	 * @docs refresh
	 * 刷新树数据，必要时触发视图更新。
	 */
	public async refresh(force = false): Promise<void> {
		this.nodes = await this.dataManager.getWindowNodes();
		const hash = JSON.stringify(this.nodes.map((item) => ({ id: item.stableId, relativeActive: item.relativeActive, path: item.path, title: item.title })));
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
		item.iconPath = getNodeIcon(element, isCurrentWorkspace(element.path, element.uri), this.dataManager);
		item.description = buildDescription(element);
		item.tooltip = buildTooltip(element);
		item.contextValue = buildContextValue(element);
			try {
				if (element.origin === 'saved') {
					console.debug(`[vscode-window-tracker] contextValue for ${item.id}: ${item.contextValue}`);
				}
			} catch {
			}
		const current = isCurrentWorkspace(element.path, element.uri);
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
