import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
	const provider = new WindowTreeDataProvider(context);
	vscode.window.createTreeView('multiwindowmanager.windowsView', {
		treeDataProvider: provider,
		showCollapseAll: true,
	});

	context.subscriptions.push(
		vscode.commands.registerCommand('multiwindowmanager.refresh', async () => {
			await provider.refresh();
		}),
		vscode.commands.registerCommand('multiwindowmanager.switch', async (item?: WindowNode) => {
			if (!item || item.type !== 'window' || !item.dirUri) {
				return;
			}
			await vscode.commands.executeCommand('vscode.openFolder', item.dirUri, { forceNewWindow: false });
		}),
		vscode.commands.registerCommand('multiwindowmanager.openNewWindow', async (item?: WindowNode) => {
			if (!item || item.type !== 'window' || !item.dirUri) {
				return;
			}
			await vscode.commands.executeCommand('vscode.openFolder', item.dirUri, { forceNewWindow: true });
		}),
		vscode.commands.registerCommand('multiwindowmanager.newFolder', async (item?: WindowNode) => {
			if (!item || item.type !== 'window') {
				return;
			}
			const baseUri = item?.dirUri;
			if (!baseUri) {
				vscode.window.showWarningMessage('当前项没有可用目录路径。');
				return;
			}
			const name = await vscode.window.showInputBox({
				prompt: '输入新目录名称',
				ignoreFocusOut: true,
				validateInput: (value) => (value.trim().length ? null : '目录名不能为空'),
			});
			if (!name) {
				return;
			}
			const target = vscode.Uri.joinPath(baseUri, name.trim());
			await vscode.workspace.fs.createDirectory(target);
			await provider.refresh();
			vscode.window.showInformationMessage(`已创建目录: ${target.fsPath}`);
		}),
		vscode.commands.registerCommand('multiwindowmanager.reveal', async (item?: WindowNode) => {
			if (!item || item.type !== 'window' || !item.dirUri) {
				return;
			}
			await vscode.commands.executeCommand('revealInExplorer', item.dirUri);
		}),
		vscode.commands.registerCommand('multiwindowmanager.copyPath', async (item?: WindowNode) => {
			if (!item || item.type !== 'window') {
				return;
			}
			const value = item.path ?? item.dirUri?.fsPath;
			if (!value) {
				return;
			}
			await vscode.env.clipboard.writeText(value);
			vscode.window.showInformationMessage('路径已复制。');
		}),
		vscode.commands.registerCommand('multiwindowmanager.togglePin', async (item?: WindowNode) => {
			if (!item || item.type !== 'window' || !item.stableId) {
				return;
			}
			await provider.togglePin(item.stableId);
		})
	);

	provider.startHeartbeat(context);
}

export function deactivate() {}

type WindowState = 'focused' | 'visible' | 'idle';

interface WindowRecord {
	title?: string;
	path?: string;
	uri?: string;
	pid?: number;
	windowId?: number | string;
	lastActive?: number;
	source?: string;
	status?: string;
}

interface WindowGroupItem {
	type: 'group';
	group: WindowState;
	count: number;
}

interface WindowNode extends WindowRecord {
	type: 'window';
	stableId: string;
	state: WindowState;
	pinned: boolean;
	dirUri?: vscode.Uri;
	relativeActive: string;
}

class WindowTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private nodes: WindowNode[] = [];
	private pinSet: Set<string>;
	private lastHash = '';

	constructor(private readonly context: vscode.ExtensionContext) {
		const stored = context.globalState.get<string[]>('multiwindowmanager.pins', []);
		this.pinSet = new Set(stored);
	}

	private getConfig<T = any>(key: string, fallback?: T): T {
		const cfg = vscode.workspace.getConfiguration('multiwindowmanager');
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

	public async togglePin(stableId: string): Promise<void> {
		if (this.pinSet.has(stableId)) {
			this.pinSet.delete(stableId);
		} else {
			this.pinSet.add(stableId);
		}
		await this.context.globalState.update('multiwindowmanager.pins', [...this.pinSet]);
		await this.refresh(true);
	}

	public async refresh(force = false): Promise<void> {
		const loaded = await this.loadRecords();
		this.nodes = this.normalizeNodes(loaded);
		const hash = JSON.stringify(this.nodes.map((item) => ({
			id: item.stableId,
			state: item.state,
			pinned: item.pinned,
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

		const title = element.title || element.path || 'Untitled Window';
		const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
		item.id = element.stableId;
		item.iconPath = this.getNodeIcon(element);
		item.description = this.buildDescription(element);
		item.tooltip = this.buildTooltip(element);
		item.contextValue = this.buildContextValue(element);
		item.command = {
			command: 'multiwindowmanager.switch',
			title: 'Switch',
			arguments: [element],
		};
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
							pinned: false,
							dirUri: undefined,
							relativeActive: 'now',
						},
					];
				}
			return this.nodes;
		}
		return [];
	}

	private async loadRecords(): Promise<WindowRecord[]> {
		const preferDaemon = this.getConfig<boolean>('preferDaemon', false);
		const fromDaemon = preferDaemon ? await this.loadDaemonFile() : [];
		if (fromDaemon && fromDaemon.length) {
			return this.dedupe(fromDaemon);
		}
		const fromTracker = await this.loadTrackerFiles();
		const fromWorkspace = this.loadCurrentWorkspaceRecord();
		return this.dedupe([fromWorkspace, ...fromTracker]);
	}

	private async loadDaemonFile(): Promise<WindowRecord[]> {
		const rawPath = this.getConfig<string>('daemonFile', '~/.vscode-window-daemon.json');
		const expanded = rawPath.replace(/^~(?=$|\/|\\)/, os.homedir());
		try {
			const content = await fs.readFile(expanded, 'utf8');
			const parsed = JSON.parse(content);
				if (Array.isArray(parsed)) {
					return parsed as WindowRecord[];
				}
				if (parsed && Array.isArray(parsed.windows)) {
					return parsed.windows as WindowRecord[];
				}
				if (parsed && typeof parsed === 'object') {
					return [parsed as WindowRecord];
				}
			return [];
		} catch {
			return [];
		}
	}

	private loadCurrentWorkspaceRecord(): WindowRecord {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const folderPath = workspaceFolder?.uri.fsPath;
		return {
			title: vscode.window.activeTextEditor?.document.fileName ? path.basename(vscode.window.activeTextEditor.document.fileName) : 'Current Workspace',
			path: folderPath,
			uri: workspaceFolder?.uri.toString(),
			lastActive: Date.now(),
			source: 'vscode',
			status: 'focused',
		};
	}

	private async loadTrackerFiles(): Promise<WindowRecord[]> {
		const trackerDir = path.join(os.homedir(), '.vscode-window-tracker');
		try {
			const files = await fs.readdir(trackerDir);
			const jsonFiles = files.filter((file) => file.endsWith('.json'));
			const records = await Promise.all(jsonFiles.map(async (file) => {
				const filePath = path.join(trackerDir, file);
				try {
					const content = await fs.readFile(filePath, 'utf8');
					const raw = JSON.parse(content);
					if (Array.isArray(raw)) {
						return raw as WindowRecord[];
					}
					if (raw && Array.isArray(raw.windows)) {
						return raw.windows as WindowRecord[];
					}
					if (raw && typeof raw === 'object') {
						return [raw as WindowRecord];
					}
				} catch {
					return [];
				}
				return [];
			}));
			return records.flat();
		} catch {
			return [];
		}
	}

	private dedupe(records: WindowRecord[]): WindowRecord[] {
		const map = new Map<string, WindowRecord>();
		for (const record of records) {
			const keys = this.buildDedupKeys(record);
			const winnerKey = keys.find((key) => map.has(key));
			if (winnerKey) {
				const current = map.get(winnerKey)!;
				if ((record.lastActive ?? 0) > (current.lastActive ?? 0)) {
					map.set(winnerKey, record);
				}
				continue;
			}
			map.set(keys[0], record);
		}
		return [...map.values()];
	}

	private buildDedupKeys(record: WindowRecord): string[] {
		const uriOrPath = record.uri || record.path || 'unknown';
		const windowId = record.windowId ?? 'none';
		const pid = record.pid ?? 'none';
		const title = (record.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
		return [
			`${uriOrPath}::${windowId}`,
			`${uriOrPath}::${pid}`,
			`title::${title}`,
		];
	}

	private normalizeNodes(records: WindowRecord[]): WindowNode[] {
		const now = Date.now();
		const idleMinutes = this.getConfig<number>('idleThresholdMinutes', 30);
		const idleThresholdMs = idleMinutes * 60 * 1000;
		const enriched = records.map((record, index) => {
			const stableId = this.buildDedupKeys(record)[0] || `${record.path || record.title || 'window'}-${index}`;
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
				pinned: this.pinSet.has(stableId),
				dirUri,
				relativeActive: this.toRelativeTime(lastActive),
			};
		});

		return enriched.sort((a, b) => {
			if (a.pinned !== b.pinned) {
				return a.pinned ? -1 : 1;
			}
			const stateOrder = this.stateOrder(a.state) - this.stateOrder(b.state);
			if (stateOrder !== 0) {
				return stateOrder;
			}
			return (b.lastActive ?? 0) - (a.lastActive ?? 0);
		});
	}

	private buildDescription(node: WindowNode): string {
		const shortPath = node.path ? path.basename(node.path) : 'no-path';
		const pinned = node.pinned ? '📌 ' : '';
		return `${pinned}${shortPath} · ${node.relativeActive}`;
	}

	private buildTooltip(node: WindowNode): vscode.MarkdownString {
		const md = new vscode.MarkdownString(undefined, true);
		md.appendMarkdown(`**${node.title || 'Untitled Window'}**\n\n`);
		md.appendMarkdown(`- status: ${node.state}${node.pinned ? ' + pinned' : ''}\n`);
		md.appendMarkdown(`- path: ${node.path || '-'}\n`);
		md.appendMarkdown(`- pid: ${node.pid ?? '-'}\n`);
		md.appendMarkdown(`- lastActive: ${node.lastActive ? new Date(node.lastActive).toLocaleString() : '-'}\n`);
		md.appendMarkdown(`- source: ${node.source || '-'}\n`);
		md.appendMarkdown(`- status(raw): ${node.status || '-'}\n`);
		md.isTrusted = false;
		return md;
	}

	private buildContextValue(node: WindowNode): string {
		void node;
		return 'windowItem';
	}

	private getNodeIcon(node: WindowNode): vscode.ThemeIcon {
		if (node.pinned) {
			return new vscode.ThemeIcon('pin');
		}
		if (node.state === 'focused') {
			return new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.blue'));
		}
		if (node.state === 'visible') {
			return new vscode.ThemeIcon('eye');
		}
		return new vscode.ThemeIcon('circle-large-outline');
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

type TreeNode = WindowNode | WindowGroupItem;
