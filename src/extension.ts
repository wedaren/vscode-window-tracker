import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { WindowTreeDataProvider } from './treeProvider';
import { WindowNode } from './types';
import { createDataManager, isCurrentWorkspace } from './dataManager';
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

      // 安全校验：解析 URI scheme。
      // 只允许本地文件 (file) 或 VS Code 虚拟文件系统 (vscode-vfs, vscode-test-web 等常用安全 scheme)。
      // 防止恶意 saved.json 包含 ssh://, vsls:// 等危险 scheme 导致 RCE/SSRF。
      const allowedSchemes = ['file', 'vscode-vfs', 'vscode-test-web', 'vscode-remote'];
      const scheme = item.dirUri.scheme;

      if (!allowedSchemes.includes(scheme)) {
        const choice = await vscode.window.showWarningMessage(
          `警告: 该项目试图使用非标准协议 (${scheme}) 打开路径。是否继续？`,
          '继续打开',
          '取消'
        );
        if (choice !== '继续打开') {
          return;
        }
      }

      await vscode.commands.executeCommand('vscode.openFolder', item.dirUri, true);
    }),

    vscode.commands.registerCommand(
      'vscode-window-tracker.addProject', async (item?: WindowNode) => {
        await provider.addProjectByNode(item);
      }
    ),
    vscode.commands.registerCommand('vscode-window-tracker.openSavedJson', async () => {
      try {
        const cfg = ConfigService.getInstance();
        const trackerDir = cfg.trackerDir;
        const savedPath = path.join(trackerDir, 'saved.json');
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
    ),
    vscode.commands.registerCommand(
      'vscode-window-tracker.closeWindow',
      async (item?: WindowNode) => {
        if (item && !isCurrentWorkspace(item.path, item.uri)) {
          return;
        }
        await vscode.commands.executeCommand('workbench.action.closeWindow');
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
