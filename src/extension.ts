import * as vscode from 'vscode';
import { WindowTreeDataProvider } from './treeProvider';
import { WindowNode } from './types';
import { createDataManager } from './dataManager';

let dataManager: ReturnType<typeof createDataManager> | undefined;
let extContext: vscode.ExtensionContext | undefined;

export function activate(context: vscode.ExtensionContext) {
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

    vscode.commands.registerCommand(
      'vscode-window-tracker.addProject',
      async (item?: WindowNode) => {
        await provider.addProjectByNode(item);
      }
    ),
    vscode.commands.registerCommand(
      'vscode-window-tracker.removeProject',
      async (item?: WindowNode) => {
        if (!item || item.type !== 'window' || !item.stableId) {
          return;
        }
        await provider.removeProjectById(item.stableId);
      }
    )
  );

  provider.startHeartbeat(context);

  dataManager = createDataManager(context);
  dataManager.startTracker();
  context.subscriptions.push({
    dispose: () => {
      dataManager?.stopTracker();
    },
  });
}
