import * as vscode from 'vscode';
import { createDataManager } from './dataManager';
import { WindowNode } from './types';
import * as view from './viewHelpers';



export class WindowTreeDataProvider implements vscode.TreeDataProvider<WindowNode> {
 	private readonly _onDidChangeTreeData = new vscode.EventEmitter<WindowNode | undefined>();
 	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private nodes: WindowNode[] = [];
 	private dataManager: ReturnType<typeof createDataManager>;
 	private lastHash = '';

	constructor(private readonly context: vscode.ExtensionContext) {
		this.dataManager = createDataManager(this.context);
	}





 	public startHeartbeat(context: vscode.ExtensionContext): void {
 		void this.refresh();
		const interval = this.dataManager.getConfig<number>('heartbeatIntervalSeconds', 5) * 1000;
		const timer = setInterval(() => {
			void this.refresh();
		}, interval);
		context.subscriptions.push({ dispose: () => clearInterval(timer) });
	}

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
		await this.refresh(true);
	}

	public async removeProjectById(stableId: string): Promise<void> {
		await this.dataManager.removeSaved(stableId);
		await this.refresh(true);
	}

	public async refresh(force = false): Promise<void> {
		this.nodes = await this.dataManager.getWindowNodes();
		const hash = JSON.stringify(this.nodes.map((item) => ({ id: item.stableId, relativeActive: item.relativeActive, path: item.path, title: item.title })));
		if (force || hash !== this.lastHash) {
			this.lastHash = hash;
			this._onDidChangeTreeData.fire(undefined);
		}
	}

	public getTreeItem(element: WindowNode): vscode.TreeItem {
		const title = view.formatTitle(element);
		const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
		item.id = `${element.origin}:${element.stableId}`;
		item.iconPath = view.getNodeIcon(element, view.isCurrentWorkspace(element.path, element.uri), this.dataManager);
		item.description = view.buildDescription(element);
		item.tooltip = view.buildTooltip(element);
		item.contextValue = view.buildContextValue(element);
		try {
			if (element.origin === 'saved') {
				console.debug(`[vscode-window-tracker] contextValue for ${item.id}: ${item.contextValue}`);
			}
		} catch {
			// ignore logging errors
		}
		const isCurrentWorkspace = view.isCurrentWorkspace(element.path, element.uri);
		if (isCurrentWorkspace) {
			item.label = { label: title, highlights: [[0, title.length]] };
		}
		item.accessibilityInformation = {
			label: `${title}, ${element.relativeActive}`,
			role: 'treeitem',
		};
		return item;
	}

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





// helper methods have been moved to viewHelpers.ts

	// icon logic moved to viewHelpers

// moved to viewHelpers by proxy export

// dereferenced to viewHelpers

	// workspace-matching logic lives in viewHelpers
}
