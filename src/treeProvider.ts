import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { createDataManager, WindowRecord } from './dataManager';

export type WindowState = 'focused' | 'visible' | 'idle';

export interface WindowGroupItem {
	type: 'group';
 	group: WindowState;
 	count: number;
}

export interface WindowNode extends WindowRecord {
	type: 'window';
	stableId: string;
	state: WindowState;
	origin: 'tracked' | 'added';
	dirUri?: vscode.Uri;
	relativeActive: string;
}

export type TreeNode = WindowNode | WindowGroupItem;

export class WindowTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
 	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
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
 			state: item.state,
 			relativeActive: item.relativeActive,
 			path: item.path,
 			title: item.title,
 		})));

 		if (force || hash !== this.lastHash) {
 			this.lastHash = hash;
 			this._onDidChangeTreeData.fire(undefined);
 		}
 	}

 	public getTreeItem(element: TreeNode): vscode.TreeItem {
 		if (element.type === 'group') {
 			const groupLabel = `${this.getStateLabel(element.group)} (${element.count})`;
 			const groupItem = new vscode.TreeItem(groupLabel, vscode.TreeItemCollapsibleState.Expanded);
 			groupItem.contextValue = `windowGroup.${element.group}`;
 			groupItem.iconPath = this.getGroupIcon(element.group);
 			groupItem.accessibilityInformation = {
 				label: groupLabel,
 				role: 'group',
 			};
 			return groupItem;
 		}

		let title = 'Untitled Window';
		if (element.type === 'window') {
			if (element.path) {
				title = path.basename(element.path);
			} else if (element.uri) {
				try {
					const u = vscode.Uri.parse(element.uri);
					title = path.basename(u.fsPath) || u.path.split('/').pop() || u.toString();
				} catch {
					// ignore
				}
			} else if (element.title) {
				title = element.title;
			}
		} else {
			const g = (element as WindowGroupItem).group;
			title = g ? this.getStateLabel(g) : title;
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
 		if (element.state === 'focused') {
 			item.label = { label: title, highlights: [[0, title.length]] };
 		}
 		item.accessibilityInformation = {
 			label: `${title}, ${this.getStateLabel(element.state)}, ${element.relativeActive}`,
 			role: 'treeitem',
 		};
 		return item;
 	}

 	public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
 		const groupThreshold = this.getConfig<number>('groupThreshold', 200);
 		if (this.nodes.length > groupThreshold) {
 			if (!element) {
 				const groups: WindowState[] = ['focused', 'visible', 'idle'];
 				return groups.map((group) => ({
 					type: 'group',
 					group,
 					count: this.nodes.filter((node) => node.state === group).length,
 				}));
 			}
 			if (element.type === 'group') {
 				return this.nodes.filter((node) => node.state === element.group);
 			}
 		}
 		if (!element || element.type === 'group') {
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
						state: 'idle',
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
 		const idleMinutes = this.getConfig<number>('idleThresholdMinutes', 30);
 		const idleThresholdMs = idleMinutes * 60 * 1000;
		const enriched = records.map((record, index) => {
			const stableId = this.dataManager.buildDedupKeys(record)[0] || `${record.path || record.title || 'window'}-${index}`;
 			const dirUri = this.toDirUri(record.path, record.uri);
 			const lastActive = record.lastActive ?? now;
 			const idle = now - lastActive >= idleThresholdMs;
 			const focused = record.status === 'focused' || record.status === 'active';
 			const state: WindowState = focused ? 'focused' : idle ? 'idle' : 'visible';
			return {
				type: 'window' as const,
				...record,
				stableId,
				state,
				origin: 'tracked' as const,
				dirUri,
				relativeActive: this.toRelativeTime(lastActive),
			};
 		});

		const sorted = enriched.sort((a, b) => {
			// no pin ordering; keep ordering by state then lastActive
			const stateOrder = this.stateOrder(a.state) - this.stateOrder(b.state);
			if (stateOrder !== 0) {
				return stateOrder;
			}
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
					state: 'idle',
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
					state: 'idle',
					origin: 'added' as const,
					dirUri: undefined,
					relativeActive: 'now',
				};
			}
			addedNodes.push(created);
		}

		// tracked nodes first, then added nodes
		const combined: WindowNode[] = [...sorted, ...addedNodes];
		return combined;
	}

	private buildDescription(node: WindowNode): string {
		const shortPath = node.path ? path.basename(node.path) : 'no-path';
		return `${shortPath} · ${node.relativeActive}`;
	}

 	private buildTooltip(node: WindowNode): vscode.MarkdownString {
 		const md = new vscode.MarkdownString(undefined, true);
 		md.appendMarkdown(`**${node.title || 'Untitled Window'}**\n\n`);
		md.appendMarkdown(`- status: ${node.state}\n`);
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
		if (node.state === 'focused') {
			return new vscode.ThemeIcon('repo', new vscode.ThemeColor('charts.blue'));
		}
		// other opened windows grey icon
		if (node.state === 'visible') {
			return new vscode.ThemeIcon('repo', new vscode.ThemeColor('disabledForeground'));
		}
		// idle or unknown
		return added ? new vscode.ThemeIcon('database') : new vscode.ThemeIcon('circle-large-outline');
	}

 	private getGroupIcon(state: WindowState): vscode.ThemeIcon {
 		if (state === 'focused') {
 			return new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.blue'));
 		}
 		if (state === 'visible') {
 			return new vscode.ThemeIcon('eye');
 		}
 		return new vscode.ThemeIcon('circle-large-outline');
 	}

 	private getStateLabel(state: WindowState): string {
 		switch (state) {
 			case 'focused':
 				return 'Focused';
 			case 'visible':
 				return 'Visible';
 			default:
 				return 'Idle';
 		}
 	}

 	private stateOrder(state: WindowState): number {
 		if (state === 'focused') {
 			return 0;
 		}
 		if (state === 'visible') {
 			return 1;
 		}
 		return 2;
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
}
