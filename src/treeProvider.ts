import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { createDataManager, WindowRecord } from './dataManager';

export interface WindowNode extends WindowRecord {
	type: 'window';
	stableId: string;
	origin: 'tracked' | 'added';
	dirUri?: vscode.Uri;
	relativeActive: string;
}

export class WindowTreeDataProvider implements vscode.TreeDataProvider<WindowNode> {
 	private readonly _onDidChangeTreeData = new vscode.EventEmitter<WindowNode | undefined>();
 	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

 	private nodes: WindowNode[] = [];
	 private addedSet: Set<string>;
 	 private dataManager: ReturnType<typeof createDataManager>;
 	private lastHash = '';

	constructor(private readonly context: vscode.ExtensionContext) {
		this.dataManager = createDataManager(this.context);
		const added = this.dataManager.getAddedArray();
		this.addedSet = new Set(added);
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

	public isAdded(stableId: string): boolean {
		return this.addedSet.has(stableId);
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
		this.addedSet.add(stableId);
		await this.dataManager.persistAddedArray([...this.addedSet]);
		await this.refresh(true);
	}

	public async removeProjectById(stableId: string): Promise<void> {
		if (this.addedSet.has(stableId)) {
			this.addedSet.delete(stableId);
			await this.dataManager.persistAddedArray([...this.addedSet]);
			await this.refresh(true);
		}
	}

 	public async refresh(force = false): Promise<void> {
 		const loaded = await this.dataManager.loadAllRecords();
 		this.nodes = this.normalizeNodes(loaded);
 		const hash = JSON.stringify(this.nodes.map((item) => ({
 			id: item.stableId,

 			relativeActive: item.relativeActive,
 			path: item.path,
 			title: item.title,
 		})));

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
 		item.id = element.stableId;
 		item.iconPath = this.getNodeIcon(element);
 		item.description = this.buildDescription(element);
 		item.tooltip = this.buildTooltip(element);
 		item.contextValue = this.buildContextValue(element);
		// Diagnostic logging to help verify inline menu/context tokens at runtime.
		// Only log for added items to reduce noise.
		try {
			if (element.origin === 'added') {
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



 	private normalizeNodes(records: WindowRecord[]): WindowNode[] {
 		const now = Date.now();
		const enriched = records.map((record, index) => {
			const stableId = this.dataManager.buildDedupKeys(record)[0] || `${record.path || record.title || 'window'}-${index}`;
			const dirUri = this.toDirUri(record.path, record.uri);
			const lastActive = record.lastActive ?? now;
			return {
				type: 'window' as const,
				...record,
				stableId,
				origin: 'tracked' as const,
				dirUri,
				relativeActive: this.toRelativeTime(lastActive),
			};
		});

		const sorted = enriched.sort((a, b) => {
			// Sort by lastActive (most recent first)
			return (b.lastActive ?? 0) - (a.lastActive ?? 0);
		});

		// Ensure added projects (from addedSet) are present in the list.
		const existingIds = new Set(sorted.map((n) => n.stableId));
		const addedNodes: WindowNode[] = [];
		for (const addedId of this.addedSet) {
			if (existingIds.has(addedId)) {
				continue;
			}
			// try to parse as uri/file
			let created: WindowNode | null = null;
			// If the added id looks like a dedupe key (e.g. 'path::none'), prefer the
			// portion before the '::' as the candidate path/uri. Also expand '~'.
			let candidate = addedId;
			if (addedId.includes('::')) {
				candidate = addedId.split('::')[0];
			}
			if (candidate.startsWith('~')) {
				candidate = candidate.replace(/^~(?=$|\/|\\)/, os.homedir());
			}
			try {
				// Check for URI scheme first; if present, parse as URI, otherwise treat as file path.
				let u: vscode.Uri;
				if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
					u = vscode.Uri.parse(candidate);
				} else {
					u = vscode.Uri.file(candidate);
				}
				const p = u.fsPath || candidate;
				created = {
					type: 'window',
					stableId: addedId,
					title: path.basename(p) || addedId,
					path: p,
					uri: u.toString(),
					pid: undefined,
					windowId: undefined,
					lastActive: Date.now(),
					source: 'added',
					status: 'idle',
					origin: 'added' as const,
					dirUri: u,
					relativeActive: 'now',
				};
			} catch {
				// fallback: use id as title
				created = {
					type: 'window',
					stableId: addedId,
					title: addedId,
					path: undefined,
					uri: undefined,
					pid: undefined,
					windowId: undefined,
					lastActive: Date.now(),
					source: 'added',
					status: 'idle',
					origin: 'added' as const,
					dirUri: undefined,
					relativeActive: 'now',
				};
			}
			addedNodes.push(created);
		}

		// Combine and sort: tracked nodes first, then added nodes
		// Within each group, sort by lastActive
		const combined: WindowNode[] = [...sorted, ...addedNodes].sort((a, b) => {
			// First sort by origin: tracked before added
			if (a.origin !== b.origin) {
				return a.origin === 'tracked' ? -1 : 1;
			}
			// Within same origin, sort by lastActive (most recent first)
			return (b.lastActive ?? 0) - (a.lastActive ?? 0);
		});
		return combined;
	}

	private buildDescription(node: WindowNode): string {
		const shortPath = node.path ? path.basename(node.path) : 'no-path';
		return `${shortPath} · ${node.relativeActive}`;
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
		//  - windowItem:added
		//  - windowItem:tracked
		//  - windowItem:tracked:allowAdd
		let added = false;
		try {
			added = this.isAdded(node.stableId);
		} catch {
			// defensive: placeholder nodes may cause isAdded to throw; treat as not added
			added = false;
		}
		if (added) {
			return 'windowItem:added';
		}
		if (node.origin === 'added') {
			return 'windowItem:added';
		}
		// tracked nodes: expose whether adding is allowed
		if (!added) {
			return 'windowItem:tracked:allowAdd';
		}
		return 'windowItem:tracked';
	}

	private getNodeIcon(node: WindowNode): vscode.ThemeIcon {
		const added = this.isAdded(node.stableId);
		const isCurrentWorkspace = this.isCurrentWorkspace(node.path, node.uri);
		if (isCurrentWorkspace) {
			return new vscode.ThemeIcon('repo', new vscode.ThemeColor('charts.blue'));
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
