import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WindowTreeDataProvider, WindowNode } from './treeProvider';

let trackerFilePath: string | undefined;
let extContext: vscode.ExtensionContext | undefined;

export function activate(context: vscode.ExtensionContext) {

	// store context for deactivate cleanup
	extContext = context;
	const provider = new WindowTreeDataProvider(context);
	vscode.window.createTreeView('vscode-window-tracker.windowsView', {
		treeDataProvider: provider,
		showCollapseAll: true,
	});

	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-window-tracker.refresh', async () => {
			await provider.refresh();
		}),
		vscode.commands.registerCommand('vscode-window-tracker.reveal', async (item?: WindowNode) => {
			if (!item || item.type !== 'window' || !item.dirUri) {
				return;
			}
			await vscode.commands.executeCommand('vscode.openFolder', item.dirUri, true);
		}),
		
		vscode.commands.registerCommand('vscode-window-tracker.addProject', async (item?: WindowNode) => {
			await provider.addProjectByNode(item);
		}),
		vscode.commands.registerCommand('vscode-window-tracker.removeProject', async (item?: WindowNode) => {
			if (!item || item.type !== 'window' || !item.stableId) {
				return;
			}
			await provider.removeProjectById(item.stableId);
		})
	);

	provider.startHeartbeat(context);

	// Start writing tracker file so other instances can discover this window
	const cfg = vscode.workspace.getConfiguration('vscode-window-tracker');
	const rawTrackerDir = cfg.get<string>('trackerDir', '~/.vscode-window-tracker')!;
	const trackerDir = rawTrackerDir.replace(/^~(?=$|\/|\\)/, os.homedir());
	async function ensureTrackerDir(): Promise<void> {
		try {
			await fs.mkdir(trackerDir, { recursive: true });
		} catch {
			// ignore
		}
	}

	async function writeTrackerFileNow() {
		await ensureTrackerDir();
		if (!trackerFilePath) {
			const fname = `vscode-${process.pid}-${Date.now()}.json`;
			trackerFilePath = path.join(trackerDir, fname);
			// persist the filename for this session
			await context.globalState.update('vscode-window-tracker.trackerFile', trackerFilePath);
		}

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const folderPath = workspaceFolder?.uri.fsPath;
		const rec = {
			title: vscode.window.activeTextEditor?.document.fileName ? path.basename(vscode.window.activeTextEditor.document.fileName) : 'Current Workspace',
			path: folderPath,
			uri: workspaceFolder?.uri.toString(),
			pid: process.pid,
			lastActive: Date.now(),
			source: 'vscode-extension',
			status: vscode.window.state.focused ? 'focused' : 'visible',
		};
		// atomic write: write to tmp then rename
		try {
			const tmp = `${trackerFilePath}.tmp`;
			await fs.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
			await fs.rename(tmp, trackerFilePath);
		} catch (e) {
			console.error('Failed to write tracker file', e);
		}
	}

	// restore existing trackerFilePath from previous run if present
	trackerFilePath = context.globalState.get<string>('vscode-window-tracker.trackerFile');

	// Remove a tracker file if present (used on deactivate/exit)
	async function removeTrackerFileNow() {
		if (!trackerFilePath) return;
		try {
			await fs.unlink(trackerFilePath);
		} catch {
			// ignore errors (file may already be removed)
		}
		trackerFilePath = undefined;
		await context.globalState.update('vscode-window-tracker.trackerFile', undefined);
	}

	// On activate optionally cleanup stale files in trackerDir
	(async function startupCleanup() {
		try {
		const cfg = vscode.workspace.getConfiguration('vscode-window-tracker');
			const auto = cfg.get<boolean>('trackerAutoCleanup', true);
			if (!auto) return;
			const staleMinutes = cfg.get<number>('trackerFileStaleMinutes', 30) ?? 30;
			const cutoff = Date.now() - staleMinutes * 60 * 1000;
			const files = await fs.readdir(trackerDir).catch(() => []);
			for (const f of files) {
				if (!f.endsWith('.json')) continue;
				const fp = path.join(trackerDir, f);
				try {
					const c = await fs.readFile(fp, 'utf8');
					const parsed = JSON.parse(c);
					const last = parsed && typeof parsed.lastActive === 'number' ? parsed.lastActive : undefined;
					if (last && last < cutoff) {
						await fs.unlink(fp).catch(() => {});
					}
				} catch {
					// ignore parse/read errors
				}
			}
		} catch {
			// ignore startup cleanup errors
		}
	})();

	// heartbeat to update tracker file
	const heartbeatSeconds = cfg.get<number>('heartbeatIntervalSeconds', 5) ?? 5;
	const trackerTimer = setInterval(() => {
		void writeTrackerFileNow();
	}, heartbeatSeconds * 1000);
	context.subscriptions.push({ dispose: () => clearInterval(trackerTimer) });

	// update on window focus change and active editor change
	context.subscriptions.push(vscode.window.onDidChangeWindowState(() => void writeTrackerFileNow()));
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => void writeTrackerFileNow()));

	// ensure tracker file is removed on normal deactivate and on process exit/signals
	context.subscriptions.push({ dispose: () => { void removeTrackerFileNow(); } });
	process.on('exit', () => { void removeTrackerFileNow(); });
	process.on('SIGINT', () => { void removeTrackerFileNow(); process.exit(130); });
	process.on('SIGTERM', () => { void removeTrackerFileNow(); process.exit(137); });
	process.on('uncaughtException', () => { void removeTrackerFileNow(); process.exit(1); });

}

export function deactivate() {
	// attempt best-effort cleanup using stored extContext
	try {
		void (async () => {
			if (!extContext) return;
			const pathToRemove = extContext.globalState.get<string>('vscode-window-tracker.trackerFile');
			if (pathToRemove) {
				try { await fs.unlink(pathToRemove); } catch { }
				await extContext.globalState.update('vscode-window-tracker.trackerFile', undefined);
			}
		})();
	} catch {
		// ignore
	}
}


