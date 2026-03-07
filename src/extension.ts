import * as vscode from 'vscode';
import { WindowTreeDataProvider } from './treeProvider';
import { WindowNode } from './types';
import { createDataManager } from './dataManager';
import { ConfigService } from './configService';

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
      'vscode-window-tracker.addProject', async (item?: WindowNode) => {
        await provider.addProjectByNode(item);
      }
    ),
    // 打开 saved.json 供用户编辑（视图标题栏按钮触发）
    vscode.commands.registerCommand('vscode-window-tracker.openSavedJson', async () => {
      try {
        const cfg = ConfigService.getInstance();
        const trackerDir = cfg.trackerDir;
        const savedPath = require('path').join(trackerDir, 'saved.json');
        const fs = require('fs/promises');
        try {
          await fs.access(savedPath);
        } catch {
          // 文件不存在，创建一个空数组文件
          try {
            await fs.mkdir(trackerDir, { recursive: true });
          } catch {}
          await fs.writeFile(savedPath, JSON.stringify([], null, 2), 'utf8');
        }
        const doc = await vscode.workspace.openTextDocument(savedPath);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        void vscode.window.showErrorMessage('无法打开 saved.json: ' + String(err));
      }
    }),
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
