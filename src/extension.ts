import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { WindowTreeDataProvider } from './treeProvider';
import { WindowNode } from './types';
import { createDataManager, isCurrentWorkspace } from './dataManager';
import { ConfigService } from './configService';
import { buildKeybindingSnippet, isKeybindingRegistered, findKeybindingLocation } from './keybindingChecker';

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
    ),

    // 通过 stableId 打开项目（支持用户在 keybindings.json 中用此命令绑定自定义快捷键）
    vscode.commands.registerCommand(
      'vscode-window-tracker.openByStableId',
      async (args?: { stableId?: string }) => {
        const stableId = args?.stableId;
        if (!stableId) {
          void vscode.window.showWarningMessage('缺少 stableId 参数，无法打开项目。');
          return;
        }
        const dm = createDataManager(extContext!);
        const nodes = await dm.getWindowNodes();
        const node = nodes.find(n => n.stableId === stableId);
        if (!node?.dirUri) {
          void vscode.window.showWarningMessage(`找不到对应的项目: ${stableId}`);
          return;
        }
        const allowedSchemes = ['file', 'vscode-vfs', 'vscode-test-web', 'vscode-remote'];
        if (!allowedSchemes.includes(node.dirUri.scheme)) {
          const choice = await vscode.window.showWarningMessage(
            `警告: 该项目试图使用非标准协议 (${node.dirUri.scheme})。是否继续？`,
            '继续打开', '取消'
          );
          if (choice !== '继续打开') return;
        }
        await vscode.commands.executeCommand('vscode.openFolder', node.dirUri, true);
      }
    ),

    // 手动验证快捷键是否已在任意 Profile 的 keybindings.json 中注册。
    // 已注册则提示成功；未注册则复制配置片段并提供打开 keybindings.json 的入口。
    vscode.commands.registerCommand(
      'vscode-window-tracker.verifyKeybinding',
      async (item?: WindowNode) => {
        if (!item?.keybinding || !item.stableId) {
          void vscode.window.showWarningMessage('该项目没有配置快捷键，请先在 saved.json 中添加 keybinding 字段。');
          return;
        }
        const registered = await isKeybindingRegistered(item.stableId, undefined, extContext?.globalStorageUri?.fsPath);
        if (registered) {
          const choice = await vscode.window.showInformationMessage(
            `✅ 快捷键 "${item.keybinding}" 已在 keybindings.json 中注册。`,
            '打开 keybindings.json'
          );
          if (choice === '打开 keybindings.json') {
            const loc = await findKeybindingLocation(item.stableId, undefined, extContext?.globalStorageUri?.fsPath);
            if (loc) {
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(loc.filePath));
              const pos = new vscode.Position(loc.line, 0);
              await vscode.window.showTextDocument(doc, {
                preview: false,
                selection: new vscode.Range(pos, pos),
              });
            } else {
              await vscode.commands.executeCommand('workbench.action.openGlobalKeybindingsFile');
            }
          }
          return;
        }
        // 未注册：复制配置片段，提供打开文件入口
        const snippet = buildKeybindingSnippet(item.stableId, item.keybinding);
        await vscode.env.clipboard.writeText(snippet);
        const choice = await vscode.window.showWarningMessage(
          `⚠️ 未在任意 Profile 的 keybindings.json 中找到注册记录。配置片段已复制到剪贴板，请粘贴后保存。`,
          '打开 keybindings.json'
        );
        if (choice === '打开 keybindings.json') {
          await vscode.commands.executeCommand('workbench.action.openGlobalKeybindingsFile');
        }
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
