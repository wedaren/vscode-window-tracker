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
import { openGitBranchQuickPick } from './gitBranchQuickPick';
import { openNativeViewsQuickPick } from './nativeViewsQuickPick';
import { openViewsQuickPick } from './viewsQuickPick';
import { EditorsTreeProvider, EditorTabNode, EditorGroupNode } from './editorsTreeProvider';
import { GitBranchTreeProvider, BranchItemNode } from './gitBranchTreeProvider';
import { ViewsTreeProvider, ViewNode } from './viewsTreeProvider';
import { GitService } from './gitService';

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
    vscode.commands.registerCommand(
      'vscode-window-tracker.pinProject',
      async (item?: WindowNode) => {
        await provider.togglePinByNode(item, true);
      }
    ),
    vscode.commands.registerCommand(
      'vscode-window-tracker.unpinProject',
      async (item?: WindowNode) => {
        await provider.togglePinByNode(item, false);
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
    vscode.commands.registerCommand('vscode-window-tracker.openGitBranchQuickPick', () => {
      void openGitBranchQuickPick(context);
    }),

    vscode.commands.registerCommand('vscode-window-tracker.openNativeViewsQuickPick', () => {
      openNativeViewsQuickPick();
    }),

    vscode.commands.registerCommand('vscode-window-tracker.openViewsQuickPick', () => {
      void openViewsQuickPick(context);
    }),

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

          // 图标只表达属性，优先级：当前 > 置顶 > 已保存 > 普通
          // 在线状态由 label 前的小圆点统一表达，不与图标语义重复
          const isOnline = n.origin === 'tracked' || isCurrent;
          let iconId: string;
          if (isCurrent) iconId = 'record';
          else if (n.pinned) iconId = 'pinned';
          else if (n.isSaved || n.origin === 'saved') iconId = 'star-empty';
          else iconId = 'repo';
          const iconPath = new vscode.ThemeIcon(iconId);

          // label：有自定义名时只显示自定义名（原名见 detail 路径，避免重复）
          // 在线窗口前缀小圆点标识（单色 codicon，比彩色 emoji 更弱不抢眼）
          const displayTitle = `${isOnline ? '$(circle-filled) ' : ''}${n.displayName || title}`;

          // description：[当前] · 相对时间
          const descParts: string[] = [];
          if (isCurrent) descParts.push('[当前]');
          descParts.push(n.relativeActive);

          // detail：路径末两段 [· 分支名] [· N 变更]
          const rawPath = n.dirUri?.fsPath || n.path || '';
          const detailParts: string[] = [toLastTwoSegments(rawPath)];
          if (n.currentBranch) {
            detailParts.push(`$(git-branch) ${n.currentBranch}`);
          }
          if (n.recentChangedFiles && n.recentChangedFiles.length > 0) {
            detailParts.push(`$(diff) ${n.recentChangedFiles.length} 变更`);
          }
          const detail = detailParts.join(' · ');

          // 已保存项可通过按钮切换置顶
          const isSavedItem = n.isSaved || n.origin === 'saved';
          const buttons: vscode.QuickInputButton[] = isSavedItem
            ? [{
                iconPath: new vscode.ThemeIcon(n.pinned ? 'pinned' : 'pin'),
                tooltip: n.pinned ? '取消置顶' : '置顶',
              }]
            : [];

          result.push({
            _kind: 'window',
            label: displayTitle,
            description: descParts.join(' · '),
            detail,
            iconPath,
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
          const toggledSavedId = item.savedId;
          const newPinned = await dm.togglePinned(toggledSavedId);
          const updated = await dm.getWindowNodes();
          nodes.length = 0;
          nodes.push(...updated);
          const newItems = buildItems();
          qp.items = newItems;
          // 切换置顶后列表会重新排序，保持选中刚操作的项目，避免焦点漂移
          const newActive = newItems.find(
            i => i._kind === 'window' && i.savedId === toggledSavedId
          );
          if (newActive) {
            qp.activeItems = [newActive];
          }
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

  // ─── Git Branches TreeView ───
  const gitSvc = new GitService();
  const branchProvider = new GitBranchTreeProvider(context, gitSvc);
  vscode.window.createTreeView('vscode-window-tracker.branchesView', {
    treeDataProvider: branchProvider,
    showCollapseAll: true,
  });

  // 监听活跃编辑器变化，切换仓库时自动刷新
  let lastRepoRoot = '';
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async () => {
      const currentRoot = branchProvider.getRepoRoot();
      if (currentRoot && currentRoot !== lastRepoRoot) {
        lastRepoRoot = currentRoot;
        await branchProvider.refresh();
      }
    })
  );

  // 启动定时刷新（10s）
  const branchRefreshTimer = setInterval(() => {
    void branchProvider.refresh();
  }, 10_000);
  context.subscriptions.push({ dispose: () => clearInterval(branchRefreshTimer) });

  // 初次刷新
  void branchProvider.refresh();

  context.subscriptions.push(
    // 刷新 Branches 视图
    vscode.commands.registerCommand('vscode-window-tracker.refreshBranches', async () => {
      await branchProvider.refresh();
    }),

    // 切换/检出分支（TreeView 节点点击触发）
    vscode.commands.registerCommand(
      'vscode-window-tracker.switchBranch',
      async (node?: BranchItemNode) => {
        if (!node || node.type !== 'branch') return;
        const { info: branch, repoRoot } = node;

        // merge/rebase 检查
        const isMerging = await gitSvc.isMergeInProgress(repoRoot);
        if (isMerging) {
          void vscode.window.showWarningMessage(
            '当前有合并/变基/拣选正在进行，请先完成或中止后再切换分支。'
          );
          return;
        }

        // 未提交更改确认
        const hasChanges = await gitSvc.hasUncommittedChanges(repoRoot);
        if (hasChanges) {
          const choice = await vscode.window.showWarningMessage(
            '工作区有未提交的更改，切换分支可能导致冲突。是否继续？',
            '继续切换',
            '取消'
          );
          if (choice !== '继续切换') return;
        }

        try {
          if (branch.isRemote) {
            await gitSvc.checkoutRemoteBranch(repoRoot, branch.name);
            const localName = branch.name.replace(/^[^/]+\//, '');
            void vscode.window.showInformationMessage(`已从 ${branch.name} 检出分支 ${localName}`);
          } else if (branch.isCurrent) {
            void vscode.window.showInformationMessage(`已在分支 ${branch.name} 上`);
          } else {
            await gitSvc.checkoutBranch(repoRoot, branch.name);
            void vscode.window.showInformationMessage(`已切换到分支 ${branch.name}`);
          }
          await branchProvider.refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (branch.isRemote && msg.includes('already exists')) {
            const localName = branch.name.replace(/^[^/]+\//, '');
            void vscode.window.showWarningMessage(
              `本地分支 ${localName} 已存在，请直接切换本地分支。`
            );
          } else {
            void vscode.window.showErrorMessage(`切换分支失败: ${msg}`);
          }
        }
      }
    ),

    // 新建分支（TreeView title / 右键菜单）
    vscode.commands.registerCommand(
      'vscode-window-tracker.createBranchFromTree',
      async () => {
        const repoRoot = branchProvider.getRepoRoot();
        if (!repoRoot) {
          void vscode.window.showWarningMessage('当前没有可用的 Git 仓库。');
          return;
        }

        const name = await vscode.window.showInputBox({
          prompt: '输入新分支名称',
          validateInput: value => {
            if (!value || !value.trim()) return '分支名称不能为空';
            return null;
          },
        });
        if (!name) return;

        const isMerging = await gitSvc.isMergeInProgress(repoRoot);
        if (isMerging) {
          void vscode.window.showWarningMessage(
            '当前有合并/变基/拣选正在进行，请先完成或中止后再新建分支。'
          );
          return;
        }

        const hasChanges = await gitSvc.hasUncommittedChanges(repoRoot);
        if (hasChanges) {
          const choice = await vscode.window.showWarningMessage(
            '工作区有未提交的更改，新建分支可能携带这些更改。是否继续？',
            '继续',
            '取消'
          );
          if (choice !== '继续') return;
        }

        try {
          await gitSvc.createBranch(repoRoot, name.trim());
          void vscode.window.showInformationMessage(`已创建并切换到分支 ${name.trim()}`);
          await branchProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `创建分支失败: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    ),

    // 基于指定分支新建分支（TreeView 行内按钮 / 右键菜单）
    vscode.commands.registerCommand(
      'vscode-window-tracker.createBranchFromBase',
      async (node?: BranchItemNode) => {
        if (!node || node.type !== 'branch' || node.info.isRemote) {
          void vscode.window.showWarningMessage('请选择本地分支作为基础。');
          return;
        }

        const { info: baseBranch, repoRoot } = node;
        const name = await vscode.window.showInputBox({
          prompt: `基于 ${baseBranch.name} 创建新分支`,
          validateInput: value => {
            if (!value || !value.trim()) return '分支名称不能为空';
            return null;
          },
        });
        if (!name) return;

        const isMerging = await gitSvc.isMergeInProgress(repoRoot);
        if (isMerging) {
          void vscode.window.showWarningMessage(
            '当前有合并/变基/拣选正在进行，请先完成或中止后再新建分支。'
          );
          return;
        }

        const hasChanges = await gitSvc.hasUncommittedChanges(repoRoot);
        if (hasChanges) {
          const choice = await vscode.window.showWarningMessage(
            '工作区有未提交的更改，新建分支可能携带这些更改。是否继续？',
            '继续',
            '取消'
          );
          if (choice !== '继续') return;
        }

        try {
          await gitSvc.createBranchFromBase(repoRoot, name.trim(), baseBranch.name);
          void vscode.window.showInformationMessage(
            `已基于 ${baseBranch.name} 创建并切换到分支 ${name.trim()}`
          );
          await branchProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `创建分支失败: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    ),

    // 删除分支（TreeView 行内按钮 / 右键菜单）
    vscode.commands.registerCommand(
      'vscode-window-tracker.deleteBranchFromTree',
      async (node?: BranchItemNode) => {
        if (!node || node.type !== 'branch' || node.info.isCurrent || node.info.isRemote) {
          void vscode.window.showWarningMessage('无法删除当前分支或远程分支。');
          return;
        }

        const { info: branch, repoRoot } = node;
        const confirm = await vscode.window.showWarningMessage(
          `确定要删除分支 ${branch.name} 吗？`,
          { modal: true },
          '删除'
        );
        if (confirm !== '删除') return;

        try {
          const result = await gitSvc.safeDeleteBranch(repoRoot, branch.name);
          if (!result.success) {
            void vscode.window.showErrorMessage(
              `删除分支失败: ${result.error ?? '未知错误'}`
            );
            return;
          }
          const msg = result.forced
            ? `已强制删除未合并分支 ${branch.name}`
            : `已删除分支 ${branch.name}`;
          void vscode.window.showInformationMessage(msg);
          await branchProvider.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `删除分支失败: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    )
  );

  // ─── Views TreeView ───
  const viewsProvider = new ViewsTreeProvider(context);
  const viewsTreeView = vscode.window.createTreeView('vscode-window-tracker.viewsView', {
    treeDataProvider: viewsProvider,
    showCollapseAll: true,
  });

  // 根据过滤状态动态更新 title
  function updateViewsTitle() {
    const filtering = viewsProvider.isFilterHidden();
    viewsTreeView.description = filtering ? '仅显示已隐藏' : undefined;
  }

  // 初次加载
  void viewsProvider.refresh().then(updateViewsTitle);

  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-window-tracker.refreshViews', async () => {
      await viewsProvider.refresh();
    }),

    vscode.commands.registerCommand(
      'vscode-window-tracker.focusView',
      async (node?: ViewNode) => {
        if (!node || node.type !== 'view') return;
        const viewId = node.viewDef.id;
        try {
          await vscode.commands.executeCommand(`${viewId}.focus`);
        } catch {
          await vscode.commands.executeCommand(viewId);
        }
      }
    ),

    vscode.commands.registerCommand(
      'vscode-window-tracker.pinView',
      async (node?: ViewNode) => {
        if (!node || node.type !== 'view') return;
        await viewsProvider.togglePin(node.viewDef.id);
      }
    ),

    vscode.commands.registerCommand(
      'vscode-window-tracker.unpinView',
      async (node?: ViewNode) => {
        if (!node || node.type !== 'view') return;
        await viewsProvider.togglePin(node.viewDef.id);
      }
    ),

    vscode.commands.registerCommand(
      'vscode-window-tracker.hideView',
      async (node?: ViewNode) => {
        if (!node || node.type !== 'view') return;
        await viewsProvider.toggleHidden(node.viewDef.id);
      }
    ),

    vscode.commands.registerCommand(
      'vscode-window-tracker.showView',
      async (node?: ViewNode) => {
        if (!node || node.type !== 'view') return;
        await viewsProvider.toggleHidden(node.viewDef.id);
      }
    ),

    vscode.commands.registerCommand(
      'vscode-window-tracker.editViewNote',
      async (node?: ViewNode) => {
        if (!node || node.type !== 'view') return;
        const currentNote = viewsProvider.getNotes()[node.viewDef.id] || '';
        const note = await vscode.window.showInputBox({
          prompt: `为 ${node.viewDef.name} 添加备注`,
          value: currentNote,
          placeHolder: '输入备注，留空清除',
        });
        if (note === undefined) return;
        await viewsProvider.setNote(node.viewDef.id, note.trim());
        const msg = note.trim() ? `已添加备注：${note.trim()}` : '已清除备注';
        void vscode.window.showInformationMessage(msg);
      }
    ),

    vscode.commands.registerCommand(
      'vscode-window-tracker.toggleViewsHiddenFilter',
      async () => {
        const nowFiltering = await viewsProvider.toggleFilterHidden();
        updateViewsTitle();
        void vscode.window.showInformationMessage(
          nowFiltering ? '已过滤：仅显示已隐藏的视图' : '已恢复：显示所有视图'
        );
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
