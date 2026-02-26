import * as vscode from 'vscode';
import * as path from 'path';
import { createDataManager } from './dataManager';
import { WindowNode } from './types';
import SavedService from './savedService';
import TrackedService from './trackedService';



export class WindowTreeDataProvider implements vscode.TreeDataProvider<WindowNode> {
 	private readonly _onDidChangeTreeData = new vscode.EventEmitter<WindowNode | undefined>();
 	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private nodes: WindowNode[] = [];
	private savedService: SavedService;
	private trackedService: TrackedService;
	 private dataManager: ReturnType<typeof createDataManager>;
 	private lastHash = '';

	constructor(private readonly context: vscode.ExtensionContext) {
		this.dataManager = createDataManager(this.context);
		this.savedService = new SavedService(this.dataManager);
		this.trackedService = new TrackedService(this.dataManager);
	}



 	private getConfig<T = any>(key: string, fallback?: T): T {
		const cfg = vscode.workspace.getConfiguration('vscode-window-tracker');
 		const val = cfg.get<T>(key as any);
 		return (val === undefined ? (fallback as T) : val) as T;
 	}

 	public startHeartbeat(context: vscode.ExtensionContext): void {
 		void this.refresh();
 		const interval = this.getConfig<number>('heartbeatIntervalSeconds', 5) * 1000;
 		const timer = setInterval(() => {
 			void this.refresh();
 		}, interval);
 		context.subscriptions.push({ dispose: () => clearInterval(timer) });
 	}

	// pin functionality removed

	public isSaved(stableId: string): boolean {
		return this.savedService.isSaved(stableId);
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
		await this.savedService.save(stableId);
		await this.refresh(true);
	}

	public async removeProjectById(stableId: string): Promise<void> {
		await this.savedService.remove(stableId);
		await this.refresh(true);
	}

 	public async refresh(force = false): Promise<void> {
 		const loaded = await this.dataManager.loadAllRecords();
		const trackedNodes = this.trackedService.normalizeTrackedNodes(loaded);
		const trackedById = new Map(trackedNodes.map(n => [n.stableId, n]));
		let addedNodes = this.savedService.buildSavedNodes(trackedById);
		// Merge added state into tracked nodes when stableId collides. Only keep
		// standalone added nodes for those not present in trackedNodes.
		const standaloneAdded: typeof addedNodes = [];
		for (const a of addedNodes) {
			const t = trackedById.get(a.stableId);
			if (t) {
				// mark the tracked node as saved and skip creating a separate saved node
				t.isSaved = true;
			} else {
				standaloneAdded.push(a);
			}
		}
		addedNodes = standaloneAdded;
		// Combine and sort: tracked before added, each by lastActive desc
		this.nodes = [...trackedNodes, ...addedNodes].sort((a, b) => {
			if (a.origin !== b.origin) return a.origin === 'tracked' ? -1 : 1;
			return (b.lastActive ?? 0) - (a.lastActive ?? 0);
		});
		const hash = JSON.stringify(this.nodes.map((item) => ({ id: item.stableId, relativeActive: item.relativeActive, path: item.path, title: item.title })));
		if (force || hash !== this.lastHash) {
			this.lastHash = hash;
			this._onDidChangeTreeData.fire(undefined);
		}
 	}

 	public getTreeItem(element: WindowNode): vscode.TreeItem {
		let title = 'Untitled Window';
		if (element.path) {
			title = path.basename(element.path);
		} else if (element.uri) {
			try {
				const u = vscode.Uri.parse(element.uri);
				title = path.basename(u.fsPath) || path.posix.basename(u.path) || u.toString();
			} catch {
				// ignore
			}
		} else if (element.title) {
			title = element.title;
		}
 		const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
		// Ensure the TreeItem id is globally unique by including origin prefix
		item.id = `${element.origin}:${element.stableId}`;
 		item.iconPath = this.getNodeIcon(element);
 		item.description = this.buildDescription(element);
 		item.tooltip = this.buildTooltip(element);
 		item.contextValue = this.buildContextValue(element);
		// Diagnostic logging to help verify inline menu/context tokens at runtime.
		// Only log for saved items to reduce noise.
		try {
			if (element.origin === 'saved') {
				console.debug(`[vscode-window-tracker] contextValue for ${item.id}: ${item.contextValue}`);
			}
		} catch {
			// ignore logging errors
		}
		// Click on the item should not trigger any default command; keep actions in context menu only.
		const isCurrentWorkspace = this.isCurrentWorkspace(element.path, element.uri);
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





	private buildDescription(node: WindowNode): string {
		// Show only the relative time since the node was last active (i.e. how
		// long it hasn't been focused). Short path is intentionally omitted.
		return `${node.relativeActive}`;
	}

 	private buildTooltip(node: WindowNode): vscode.MarkdownString {
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

	private buildContextValue(node: WindowNode): string {
		// Use structured composite tokens (colon-separated) for clarity and
		// reliable when-clause matching. Examples:
		//  - windowItem:saved
		//  - windowItem:tracked
		//  - windowItem:tracked:allowAdd
		// Priority: origin + whether the tracked node is also in the added list.
		// - Pure saved items -> 'windowItem:saved'
		// - Tracked items that were saved by the user -> 'windowItem:tracked:saved'
		// - Tracked items not added -> 'windowItem:tracked:allowAdd'
		if (node.origin === 'saved') {
			return 'windowItem:saved';
		}
		if (node.origin === 'tracked') {
			if (node.isSaved) return 'windowItem:tracked:saved';
			return 'windowItem:tracked:allowAdd';
		}
		// fallback
		return 'windowItem:tracked';
	}

	private getNodeIcon(node: WindowNode): vscode.ThemeIcon {
		// Prefer the merged `isSaved` flag on the node when available to avoid
		// extra lookups; fall back to the savedService if it's absent.
		const added = (typeof node.isSaved === 'boolean') ? node.isSaved : this.isSaved(node.stableId);
		const isCurrentWorkspace = this.isCurrentWorkspace(node.path, node.uri);
		if (isCurrentWorkspace) {
			return new vscode.ThemeIcon('repo', new vscode.ThemeColor('charts.blue'));
		}

		if (node.origin === 'tracked') {
			return new vscode.ThemeIcon('repo');
		}
		
		return added ? new vscode.ThemeIcon('database') : new vscode.ThemeIcon('repo', new vscode.ThemeColor('disabledForeground'));
	}

 	private toRelativeTime(timestamp: number): string {
 		const diffMs = Date.now() - timestamp;
 		if (diffMs < 60_000) {
 			return 'now';
 		}
 		const mins = Math.floor(diffMs / 60_000);
 		if (mins < 60) {
 			return `${mins}m`;
 		}
 		const hours = Math.floor(mins / 60);
 		if (hours < 24) {
 			return `${hours}h`;
 		}
 		const days = Math.floor(hours / 24);
 		return `${days}d`;
 	}

 	private toDirUri(recordPath?: string, recordUri?: string): vscode.Uri | undefined {
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

	private isCurrentWorkspace(recordPath?: string, recordUri?: string): boolean {
		if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
			return false;
		}
		// Try to match by path first
		if (recordPath) {
			for (const folder of vscode.workspace.workspaceFolders) {
				if (folder.uri.fsPath === recordPath) {
					return true;
				}
			}
		}
		// Try to match by URI
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
}
