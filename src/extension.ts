import * as vscode from 'vscode';
import { WindowTreeDataProvider, WindowNode } from './treeProvider';
import { TrackerService } from './trackerService';

let trackerService: TrackerService | undefined;
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

	// Start tracker service to manage tracker file lifecycle
	trackerService = new TrackerService(context);
	trackerService.start();
	// ensure tracker is stopped when extension disposes
	context.subscriptions.push({ dispose: () => { trackerService?.stop(); } });

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


