import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { WindowTreeDataProvider } from './treeProvider';
import { WindowNode } from './types';
import { createDataManager, isCurrentWorkspace, formatTitle } from './dataManager';
import { ConfigService } from './configService';
import { buildKeybindingSnippet, isKeybindingRegistered, findKeybindingLocation } from './keybindingChecker';
import { EditorTracker } from './editorTracker';
import { openEditorsQuickPick, focusTab } from './editorsQuickPick';
import { EditorsTreeProvider, EditorTabNode, EditorGroupNode } from './editorsTreeProvider';

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

      // 在打开工作区前，确保为该文件夹初始化一个交互式 zsh 终端（-i），
      // 以便加载用户的 ~/.zshrc（如 nvm），使通过界面打开 vs code 与在终端打开时环境一致。
      try {
        const folderPath = item.dirUri.fsPath;
        const folderName = path.basename(folderPath) || folderPath;
        const MAP_KEY = 'preprocessed.env.map';
        const map = (extContext?.workspaceState.get<Record<string, string>>(MAP_KEY) as Record<string, string> | undefined) || {};
        if (!map[folderPath]) {
          const termName = `env:init ${folderName} ${Date.now()}`;
          const term = vscode.window.createTerminal({
            name: termName,
            shellPath: '/bin/zsh',
            shellArgs: ['-i'],
            cwd: folderPath,
          });
          term.show(true);
          // 不发送任何命令；仅启动交互式 shell 以加载用户环境
          map[folderPath] = termName;
          await extContext?.workspaceState.update(MAP_KEY, map);
        }
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
    // 快速选择并打开窗口（cmd+j cmd+w）
    vscode.commands.registerCommand('vscode-window-tracker.openQuickPick', async () => {
      const dm = provider.dataManager;
      const nodes = await dm.getWindowNodes();

      /** 取路径末尾两段，例如 /a/b/c/d → c/d */
      function toLastTwoSegments(p: string): string {
        if (!p) return '';
        const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
        return parts.length >= 2 ? parts.slice(-2).join('/') : parts.join('/') || p;
      }

      /** 安全打开文件夹，遇到非标准 scheme 时弹确认框 */
      async function safeOpenFolder(uri: vscode.Uri): Promise<boolean> {
        const allowedSchemes = ['file', 'vscode-vfs', 'vscode-test-web', 'vscode-remote'];
        if (!allowedSchemes.includes(uri.scheme)) {
          const choice = await vscode.window.showWarningMessage(
            `警告: 非标准协议 (${uri.scheme})，是否继续？`,
            '继续打开',
            '取消'
          );
          if (choice !== '继续打开') return false;
        }
        await vscode.commands.executeCommand('vscode.openFolder', uri, true);
        return true;
      }

      interface WindowQuickPickItem extends vscode.QuickPickItem {
        _kind: 'add-current' | 'window';
        stableId?: string;
        nodeRef?: WindowNode;
        isCurrent?: boolean;
        savedId?: string;
      }

      const currentFolderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const isCurrentInList = nodes.some(n => isCurrentWorkspace(n.path, n.uri));

      function buildItems(): WindowQuickPickItem[] {
        const result: WindowQuickPickItem[] = [];

        // 当前窗口不在列表时，置顶显示"添加"项
        if (!isCurrentInList && currentFolderPath) {
          result.push({
            _kind: 'add-current',
            label: '$(add) 添加当前窗口',
            description: path.basename(currentFolderPath),
            detail: toLastTwoSegments(currentFolderPath),
            alwaysShow: true,
          });
        }

        for (const n of nodes) {
          const isCurrent = isCurrentWorkspace(n.path, n.uri);
          const title = formatTitle(n);

          // 图标前缀：当前 > 置顶 > 已保存 > 普通
          let iconPrefix: string;
          if (isCurrent) iconPrefix = '$(record) ';
          else if (n.pinned) iconPrefix = '$(pin) ';
          else if (n.isSaved) iconPrefix = '$(star-full) ';
          else iconPrefix = '$(repo) ';

          // description：[当前] · 相对时间 [· N 变更]
          const descParts: string[] = [];
          if (isCurrent) descParts.push('[当前]');
          descParts.push(n.relativeActive);
          if (n.recentChangedFiles && n.recentChangedFiles.length > 0) {
            descParts.push(`$(diff) ${n.recentChangedFiles.length} 变更`);
          }

          // detail：路径末尾两段（简洁展示，便于扫视）
          const rawPath = n.dirUri?.fsPath || n.path || '';
          const detail = toLastTwoSegments(rawPath);

          // 已保存项可通过按钮切换置顶
          const buttons: vscode.QuickInputButton[] = n.isSaved
            ? [{
                iconPath: new vscode.ThemeIcon(n.pinned ? 'pinned' : 'pin'),
                tooltip: n.pinned ? '取消置顶' : '置顶',
              }]
            : [];

          result.push({
            _kind: 'window',
            label: `${iconPrefix}${title}`,
            description: descParts.join(' · '),
            detail,
            stableId: n.stableId,
            nodeRef: n,
            isCurrent,
            savedId: n.savedItemId || n.stableId,
            buttons,
          });
        }

        return result;
      }

      const qp = vscode.window.createQuickPick<WindowQuickPickItem>();
      qp.placeholder = '输入名称快速定位窗口 · Enter 打开 · 当前窗口 Enter 重命名';
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;
      qp.items = buildItems();

      const disposables: vscode.Disposable[] = [];

      // 点击条目上的置顶按钮
      disposables.push(
        qp.onDidTriggerItemButton(async event => {
          const item = event.item;
          if (item._kind !== 'window' || !item.savedId) return;
          const newPinned = await dm.togglePinned(item.savedId);
          const updated = await dm.getWindowNodes();
          nodes.length = 0;
          nodes.push(...updated);
          qp.items = buildItems();
          const name = item.nodeRef ? formatTitle(item.nodeRef) : item.savedId;
          void vscode.window.showInformationMessage(newPinned ? `已置顶：${name}` : `已取消置顶：${name}`);
        }),

        // 确认选择
        qp.onDidAccept(async () => {
          const picked = qp.selectedItems[0];
          if (!picked) return;

          // 快速添加当前窗口
          if (picked._kind === 'add-current') {
            qp.hide();
            if (currentFolderPath) {
              await dm.save(currentFolderPath);
              await provider.refresh(true);
            }
            return;
          }

          const node = picked.nodeRef;
          if (!node) return;

          // 当前窗口 → 直接重命名
          if (picked.isCurrent) {
            qp.hide();
            const savedId = node.savedItemId || node.stableId;
            const newName = await vscode.window.showInputBox({
              title: `重命名当前窗口：${formatTitle(node)}`,
              prompt: '输入新展示名，留空表示清除',
              value: node.displayName ?? '',
              ignoreFocusOut: true,
            });
            if (newName === undefined) return;
            await dm.upsertSavedMetadata(savedId, {
              displayName: newName.trim() || undefined,
              color: node.color,
            });
            await provider.refresh(true);
            return;
          }

          // 其他窗口 → 打开 + 累加使用次数
          qp.hide();
          if (!node.dirUri) {
            void vscode.window.showWarningMessage('无法打开所选窗口，缺少路径信息。');
            return;
          }
          const opened = await safeOpenFolder(node.dirUri);
          if (opened && node.savedItemId) {
            await dm.incrementOpenCount(node.savedItemId);
          }
        }),

        qp.onDidHide(() => {
          disposables.forEach(d => d.dispose());
          qp.dispose();
        })
      );

      qp.show();
    })
  );

  // ─── Phase 1 & 2：编辑器标签页管理 ───
  const editorTracker = EditorTracker.getInstance();
  editorTracker.start(context);

  const editorsProvider = new EditorsTreeProvider(editorTracker, context);
  vscode.window.createTreeView('vscode-window-tracker.editorsView', {
    treeDataProvider: editorsProvider,
    showCollapseAll: false,
  });

  context.subscriptions.push(
    // Phase 1：QuickPick 主入口（cmd+j cmd+e）
    vscode.commands.registerCommand(
      'vscode-window-tracker.openEditorsQuickPick',
      () => openEditorsQuickPick(editorTracker)
    ),

    // Phase 2：切换到指定标签页（由 TreeView 节点 command 触发）
    vscode.commands.registerCommand(
      'vscode-window-tracker.focusEditorTab',
      async (node?: EditorTabNode) => {
        if (!node?.tab) return;
        await focusTab(node.tab);
      }
    ),

    // Phase 2：关闭指定标签页（TreeView 上下文菜单 / 行内按钮）
    vscode.commands.registerCommand(
      'vscode-window-tracker.closeEditorTab',
      async (node?: EditorTabNode) => {
        if (!node?.tab) return;
        await vscode.window.tabGroups.close(node.tab);
      }
    ),

    // Phase 2：关闭指定编辑器组（TreeView 上下文菜单）
    vscode.commands.registerCommand(
      'vscode-window-tracker.closeEditorGroup',
      async (node?: EditorGroupNode) => {
        if (!node) return;
        const group = vscode.window.tabGroups.all.find(
          g => g.viewColumn === node.viewColumn
        );
        if (group) {
          await vscode.window.tabGroups.close(group);
        }
      }
    ),

    // Phase 2：关闭其他所有编辑器组（TreeView 上下文菜单）
    vscode.commands.registerCommand(
      'vscode-window-tracker.closeOtherEditorGroups',
      async (node?: EditorGroupNode) => {
        if (!node) return;
        const otherGroups = vscode.window.tabGroups.all.filter(
          g => g.viewColumn !== node.viewColumn
        );
        if (otherGroups.length > 0) {
          await vscode.window.tabGroups.close(otherGroups);
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
