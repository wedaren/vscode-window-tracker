import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { WindowTreeDataProvider } from './treeProvider';
import { WindowNode } from './types';
import { createDataManager, isCurrentWorkspace, formatTitle, buildDescription, getNodeIcon } from './dataManager';
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

      // 在打开工作区前，启动交互式 zsh 终端并在目标目录执行 `npm run watch`。
      // 这样可以确保加载用户的 ~/.zshrc（比如 nvm 初始化），使 npm 可用。
      try {
        const folderPath = item.dirUri.fsPath;
        const folderName = path.basename(folderPath) || folderPath;
        const term = vscode.window.createTerminal({
          name: `npm: ${folderName}`,
          shellPath: '/bin/zsh',
          shellArgs: ['-i'],
          cwd: folderPath,
        });
        term.show(true);
        // 直接在交互式 shell 中发送命令，允许用户看到过程并中断
        term.sendText('npm run watch', true);
      } catch (err) {
        // 静默失败：继续打开工作区
      }

      await vscode.commands.executeCommand('vscode.openFolder', item.dirUri, true);
    }),

    vscode.commands.registerCommand(
      'vscode-window-tracker.addProject', async (item?: WindowNode) => {
        await provider.addProjectByNode(item);
      }
    ),
    // 切换到下一个已打开的窗口（只在 tracker 中发现的打开窗口中切换）
    vscode.commands.registerCommand('vscode-window-tracker.openNextWindow', async () => {
      const dm = createDataManager(extContext!);
      const nodes = await dm.getWindowNodes();
      const openNodes = (nodes || []).filter(n => n.origin === 'tracked' && n.dirUri);
      if (openNodes.length === 0) return;
      const currentIndex = openNodes.findIndex(n => isCurrentWorkspace(n.path, n.uri));
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % openNodes.length;
      const target = openNodes[nextIndex];
      if (!target?.dirUri) {
        void vscode.window.showWarningMessage('无法切换到下一个窗口，缺少路径信息。');
        return;
      }
      const allowedSchemes = ['file', 'vscode-vfs', 'vscode-test-web', 'vscode-remote'];
      if (!allowedSchemes.includes(target.dirUri.scheme)) {
        const choice = await vscode.window.showWarningMessage(
          `警告: 该项目试图使用非标准协议 (${target.dirUri.scheme}) 打开路径。是否继续？`,
          '继续打开',
          '取消'
        );
        if (choice !== '继续打开') return;
      }
      await vscode.commands.executeCommand('vscode.openFolder', target.dirUri, true);
    }),
    // 切换到上一个已打开的窗口（只在 tracker 中发现的打开窗口中切换）
    vscode.commands.registerCommand('vscode-window-tracker.openPrevWindow', async () => {
      const dm = createDataManager(extContext!);
      const nodes = await dm.getWindowNodes();
      const openNodes = (nodes || []).filter(n => n.origin === 'tracked' && n.dirUri);
      if (openNodes.length === 0) return;
      const currentIndex = openNodes.findIndex(n => isCurrentWorkspace(n.path, n.uri));
      const prevIndex = currentIndex === -1 ? openNodes.length - 1 : (currentIndex - 1 + openNodes.length) % openNodes.length;
      const target = openNodes[prevIndex];
      if (!target?.dirUri) {
        void vscode.window.showWarningMessage('无法切换到上一个窗口，缺少路径信息。');
        return;
      }
      const allowedSchemes = ['file', 'vscode-vfs', 'vscode-test-web', 'vscode-remote'];
      if (!allowedSchemes.includes(target.dirUri.scheme)) {
        const choice = await vscode.window.showWarningMessage(
          `警告: 该项目试图使用非标准协议 (${target.dirUri.scheme}) 打开路径。是否继续？`,
          '继续打开',
          '取消'
        );
        if (choice !== '继续打开') return;
      }
      await vscode.commands.executeCommand('vscode.openFolder', target.dirUri, true);
    }),
    vscode.commands.registerCommand(
      'vscode-window-tracker.editProject',
      async (item?: WindowNode) => {
        await provider.editProjectByNode(item);
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
    ,
    // 快速选择并打开窗口
    vscode.commands.registerCommand('vscode-window-tracker.openQuickPick', async () => {
      const dm = createDataManager(extContext!);
      const nodes = await dm.getWindowNodes();
      if (!nodes || nodes.length === 0) {
        void vscode.window.showInformationMessage('未找到已跟踪的窗口。');
        return;
      }

      const items = nodes.map(n => {
        // 直接复用 tree view 的 TreeItem，以保证标题和图标完全一致
        const treeItem = provider.getTreeItem(n);
        const rawLabel = treeItem.label;
        const label = typeof rawLabel === 'string' ? rawLabel : (rawLabel && (rawLabel as any).label) || '';

        // 生成要展示的路径：优先使用 dirUri.fsPath，其次 path，再从 uri 解析；去掉尾部可能的 ::none
        let rawPath: string | undefined;
        try {
          rawPath = n.dirUri?.fsPath || n.path || (n.uri ? n.uri : undefined);
        } catch {
          rawPath = n.path;
        }
        let displayPath = '';
        if (rawPath) {
          try {
            // if it looks like a file:// URI, parse to fsPath to preserve leading slash
            if (/^file:\/\//.test(rawPath)) {
              displayPath = vscode.Uri.parse(rawPath).fsPath || '';
            } else {
              displayPath = rawPath;
            }
          } catch {
            displayPath = rawPath;
          }
        }
        // remove trailing ::... suffix (such as ::none)
        displayPath = displayPath.replace(/::.*$/, '').trim();
        // normalize placeholder values
        if (!displayPath || displayPath === 'unknown' || displayPath === 'No tracked windows') {
          displayPath = '';
        }

        return {
          label,
          description: treeItem.description ?? buildDescription(n),
          // 在 QuickPick 的第二行显示清理后的路径
          detail: displayPath,
          // 保留 stableId 以便选中后能定位原始节点
          stableId: n.stableId,
          // iconPath 复用 treeItem.iconPath（可能为 ThemeIcon，保留颜色样式）
          iconPath: treeItem.iconPath as any,
        } as vscode.QuickPickItem & { iconPath?: any; stableId: string };
      });

      const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择要打开的窗口' });
      if (!picked?.stableId) return;
      const node = nodes.find(n => n.stableId === picked.stableId);
      if (!node || !node.dirUri) {
        void vscode.window.showWarningMessage('无法打开所选窗口，缺少路径信息。');
        return;
      }

      const allowedSchemes = ['file', 'vscode-vfs', 'vscode-test-web', 'vscode-remote'];
      if (!allowedSchemes.includes(node.dirUri.scheme)) {
        const choice = await vscode.window.showWarningMessage(
          `警告: 该项目试图使用非标准协议 (${node.dirUri.scheme}) 打开路径。是否继续？`,
          '继续打开',
          '取消'
        );
        if (choice !== '继续打开') return;
      }
      await vscode.commands.executeCommand('vscode.openFolder', node.dirUri, true);
    })
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
