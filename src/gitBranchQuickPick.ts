import * as path from 'path';
import * as vscode from 'vscode';
import { GitService, BranchInfo } from './gitService';
import { toRelativeTime } from './helpers';

interface BranchQuickPickItem extends vscode.QuickPickItem {
  _kind: 'info' | 'action' | 'branch';
  actionId?: 'create-branch' | 'toggle-remote';
  branch?: BranchInfo;
}

// ─── MRU 辅助函数 ───

function mruKey(repoRoot: string): string {
  return `gitBranchMru:${repoRoot}`;
}

function readMru(context: vscode.ExtensionContext, repoRoot: string): string[] {
  return context.globalState.get<string[]>(mruKey(repoRoot), []);
}

async function writeMru(
  context: vscode.ExtensionContext,
  repoRoot: string,
  branchName: string
): Promise<void> {
  const key = mruKey(repoRoot);
  const list = context.globalState.get<string[]>(key, []);
  const filtered = list.filter(b => b !== branchName);
  filtered.unshift(branchName);
  await context.globalState.update(key, filtered.slice(0, 20));
}

async function removeMru(
  context: vscode.ExtensionContext,
  repoRoot: string,
  branchName: string
): Promise<void> {
  const key = mruKey(repoRoot);
  const list = context.globalState.get<string[]>(key, []);
  const filtered = list.filter(b => b !== branchName);
  if (filtered.length !== list.length) {
    await context.globalState.update(key, filtered);
  }
}

// ─── 排序辅助 ───

function sortBranches(branches: BranchInfo[], mru: string[]): BranchInfo[] {
  const current = branches.find(b => b.isCurrent);
  const others = branches.filter(b => !b.isCurrent);

  const mruSet = new Set(mru);
  const withMru = others.filter(b => mruSet.has(b.name));
  const withoutMru = others.filter(b => !mruSet.has(b.name));

  withMru.sort((a, b) => mru.indexOf(a.name) - mru.indexOf(b.name));
  withoutMru.sort((a, b) => (b.lastCommitMs ?? 0) - (a.lastCommitMs ?? 0));

  const result = [...withMru, ...withoutMru];
  if (current) {
    result.unshift(current);
  }
  return result;
}

// ─── 仓库选择器 ───

async function pickRepo(
  repos: { root: string; name: string; currentBranch?: string }[]
): Promise<string | undefined> {
  interface RepoItem extends vscode.QuickPickItem {
    root: string;
  }

  const items: RepoItem[] = repos.map(r => {
    const detail = path.join(
      path.basename(path.dirname(r.root)),
      path.basename(r.root)
    );
    const descParts: string[] = [];
    if (r.currentBranch) descParts.push(r.currentBranch);
    descParts.push(detail);

    return {
      label: `$(repo) ${r.name}`,
      description: descParts.join(' · '),
      root: r.root,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '选择要操作的 Git 仓库',
    matchOnDescription: true,
  });

  return picked?.root;
}

// ─── 入口 ───

/**
 * @docs openGitBranchQuickPick
 * 打开 Git 分支快速选择器（Phase 2）。
 *
 * 支持：多仓库选择、本地/远程分支切换、新建分支、删除分支、MRU 记忆排序。
 */
export async function openGitBranchQuickPick(
  context: vscode.ExtensionContext
): Promise<void> {
  const gitSvc = new GitService();

  // ─── 发现仓库 ───
  const dirs = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
  const repos = await gitSvc.findGitRepos(dirs);

  if (repos.length === 0) {
    showInfoQuickPick('$(info) 当前工作区不是 Git 仓库');
    return;
  }

  let repoRoot: string;
  if (repos.length === 1) {
    repoRoot = repos[0].root;
  } else {
    const picked = await pickRepo(repos);
    if (!picked) return;
    repoRoot = picked;
  }

  // ─── 加载分支数据 ───
  let localBranches: BranchInfo[];
  try {
    localBranches = await gitSvc.getBranches(repoRoot);
  } catch {
    showInfoQuickPick('$(warning) 无法读取分支列表');
    return;
  }

  if (localBranches.length === 0) {
    showInfoQuickPick('$(info) 未找到本地分支');
    return;
  }

  let showRemote = false;
  let remoteBranches: BranchInfo[] | undefined;
  let mru = readMru(context, repoRoot);

  // 过滤 MRU 中已不存在的分支
  const localNames = new Set(localBranches.map(b => b.name));
  const staleMru = mru.filter(n => !localNames.has(n));
  if (staleMru.length > 0) {
    mru = mru.filter(n => localNames.has(n));
    await context.globalState.update(mruKey(repoRoot), mru);
  }

  // ─── 构建 QuickPick ───
  const qp = vscode.window.createQuickPick<BranchQuickPickItem>();
  qp.placeholder = '选择分支并按 Enter 切换 · 当前分支已置顶';
  qp.matchOnDescription = true;

  function buildItems(): BranchQuickPickItem[] {
    const items: BranchQuickPickItem[] = [];

    // Action: 新建分支
    items.push({
      _kind: 'action',
      actionId: 'create-branch',
      label: '$(add) 新建分支...',
      alwaysShow: true,
    });

    // Action: 远程分支 toggle
    items.push({
      _kind: 'action',
      actionId: 'toggle-remote',
      label: showRemote
        ? '$(cloud-download) 隐藏远程分支'
        : '$(cloud) 显示远程分支',
      alwaysShow: true,
    });

    // ─── 本地分支 ───
    const sortedLocal = sortBranches(localBranches, mru);

    items.push({
      _kind: 'action',
      label: '本地分支',
      kind: vscode.QuickPickItemKind.Separator,
    });

    // 按 commit hash 分组，用于显示同 commit 分支
    const hashToNames = new Map<string, string[]>();
    for (const b of localBranches) {
      if (!b.commitHash) continue;
      const list = hashToNames.get(b.commitHash) ?? [];
      list.push(b.name);
      hashToNames.set(b.commitHash, list);
    }

    for (const b of sortedLocal) {
      const descParts: string[] = [];
      if (b.lastCommitMs) {
        descParts.push(toRelativeTime(b.lastCommitMs));
      }
      if (b.isCurrent && (b.ahead > 0 || b.behind > 0)) {
        const ab: string[] = [];
        if (b.ahead > 0) ab.push(`↑${b.ahead}`);
        if (b.behind > 0) ab.push(`↓${b.behind}`);
        if (ab.length) descParts.push(ab.join(' '));
      }

      // 同 commit 的其他分支（最多显示 2 个）
      let detail: string | undefined;
      if (b.commitHash) {
        const siblings = (hashToNames.get(b.commitHash) ?? []).filter(n => n !== b.name);
        if (siblings.length > 0) {
          const shown = siblings.slice(0, 2);
          const more = siblings.length > 2 ? ` 等 ${siblings.length} 个` : '';
          detail = `同: ${shown.join(', ')}${more}`;
        }
      }

      const buttons: vscode.QuickInputButton[] =
        !b.isCurrent && !b.isRemote
          ? [
              {
                iconPath: new vscode.ThemeIcon('trash'),
                tooltip: '删除分支',
              },
            ]
          : [];

      items.push({
        _kind: 'branch',
        label: `${b.isCurrent ? '$(record) ' : ''}${b.name}`,
        description: descParts.join(' · '),
        detail,
        branch: b,
        buttons,
      });
    }

    // ─── 远程分支 ───
    if (showRemote && remoteBranches) {
      items.push({
        _kind: 'action',
        label: '远程分支',
        kind: vscode.QuickPickItemKind.Separator,
      });

      for (const b of remoteBranches) {
        const descParts: string[] = [];
        if (b.lastCommitMs) {
          descParts.push(toRelativeTime(b.lastCommitMs));
        }

        items.push({
          _kind: 'branch',
          label: `$(cloud) ${b.name}`,
          description: descParts.join(' · '),
          branch: b,
        });
      }
    }

    return items;
  }

  qp.items = buildItems();

  const disposables: vscode.Disposable[] = [];

  // ─── 切换前检查（通用） ───
  async function runCheckoutChecks(): Promise<boolean> {
    const isMerging = await gitSvc.isMergeInProgress(repoRoot);
    if (isMerging) {
      void vscode.window.showWarningMessage(
        '当前有合并/变基/拣选正在进行，请先完成或中止后再切换分支。'
      );
      return false;
    }
    const hasChanges = await gitSvc.hasUncommittedChanges(repoRoot);
    if (hasChanges) {
      const choice = await vscode.window.showWarningMessage(
        '工作区有未提交的更改，切换分支可能导致冲突。是否继续？',
        '继续切换',
        '取消'
      );
      return choice === '继续切换';
    }
    return true;
  }

  // ─── 刷新本地分支列表 ───
  async function refreshLocalBranches(): Promise<void> {
    try {
      localBranches = await gitSvc.getBranches(repoRoot);
      // 清理 MRU 中已不存在的
      const names = new Set(localBranches.map(b => b.name));
      const cleaned = mru.filter(n => names.has(n));
      if (cleaned.length !== mru.length) {
        mru = cleaned;
        await context.globalState.update(mruKey(repoRoot), mru);
      }
      qp.items = buildItems();
    } catch {
      // 静默失败
    }
  }

  disposables.push(
    // 点击行内删除按钮
    qp.onDidTriggerItemButton(async event => {
      const item = event.item;
      if (
        item._kind !== 'branch' ||
        !item.branch ||
        item.branch.isRemote ||
        item.branch.isCurrent
      ) {
        return;
      }

      const branchName = item.branch.name;
      const confirm = await vscode.window.showWarningMessage(
        `确定要删除分支 ${branchName} 吗？`,
        { modal: true },
        '删除'
      );
      if (confirm !== '删除') return;

      try {
        const result = await gitSvc.safeDeleteBranch(repoRoot, branchName);
        if (!result.success) {
          void vscode.window.showErrorMessage(
            `删除分支失败: ${result.error ?? '未知错误'}`
          );
          return;
        }
        await removeMru(context, repoRoot, branchName);
        await refreshLocalBranches();
        void vscode.commands.executeCommand('vscode-window-tracker.refreshBranches');
        const msg = result.forced
          ? `已强制删除未合并分支 ${branchName}`
          : `已删除分支 ${branchName}`;
        void vscode.window.showInformationMessage(msg);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `删除分支失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    // 确认选择
    qp.onDidAccept(async () => {
      const picked = qp.selectedItems[0];
      if (!picked) return;

      // ─── 新建分支 ───
      if (picked._kind === 'action' && picked.actionId === 'create-branch') {
        qp.hide();

        const name = await vscode.window.showInputBox({
          prompt: '输入新分支名称',
          validateInput: value => {
            if (!value || !value.trim()) return '分支名称不能为空';
            return null;
          },
        });
        if (!name) return;

        const ok = await runCheckoutChecks();
        if (!ok) return;

        try {
          await gitSvc.createBranch(repoRoot, name.trim());
          await writeMru(context, repoRoot, name.trim());
          void vscode.commands.executeCommand('vscode-window-tracker.refreshBranches');
          void vscode.window.showInformationMessage(`已创建并切换到分支 ${name.trim()}`);
        } catch (err) {
          void vscode.window.showErrorMessage(
            `创建分支失败: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return;
      }

      // ─── 远程分支 toggle ───
      if (picked._kind === 'action' && picked.actionId === 'toggle-remote') {
        if (!showRemote && remoteBranches === undefined) {
          qp.enabled = false;
          qp.placeholder = '正在加载远程分支...';
          try {
            remoteBranches = await gitSvc.getRemoteBranches(repoRoot);
          } catch {
            remoteBranches = [];
          }
          qp.enabled = true;
          qp.placeholder = '选择分支并按 Enter 切换 · 当前分支已置顶';
        }
        showRemote = !showRemote;
        qp.items = buildItems();
        return;
      }

      // ─── 分支选择 ───
      if (picked._kind !== 'branch' || !picked.branch) return;

      const branch = picked.branch;

      // 当前分支
      if (branch.isCurrent) {
        qp.hide();
        void vscode.window.showInformationMessage(`已在分支 ${branch.name} 上`);
        return;
      }

      qp.hide();

      // 远程分支
      if (branch.isRemote) {
        const ok = await runCheckoutChecks();
        if (!ok) return;

        try {
          await gitSvc.checkoutRemoteBranch(repoRoot, branch.name);
          const localName = branch.name.replace(/^[^/]+\//, '');
          await writeMru(context, repoRoot, localName);
          void vscode.commands.executeCommand('vscode-window-tracker.refreshBranches');
          void vscode.window.showInformationMessage(`已从 ${branch.name} 检出分支 ${localName}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // 如果本地已存在同名分支，提示用户直接切换
          if (msg.includes('already exists')) {
            const localName = branch.name.replace(/^[^/]+\//, '');
            void vscode.window.showWarningMessage(
              `本地分支 ${localName} 已存在，请直接在本地分支列表中选择切换。`
            );
          } else {
            void vscode.window.showErrorMessage(`检出远程分支失败: ${msg}`);
          }
        }
        return;
      }

      // 本地分支切换
      const ok = await runCheckoutChecks();
      if (!ok) return;

      try {
        await gitSvc.checkoutBranch(repoRoot, branch.name);
        await writeMru(context, repoRoot, branch.name);
        void vscode.commands.executeCommand('vscode-window-tracker.refreshBranches');
        void vscode.window.showInformationMessage(`已切换到分支 ${branch.name}`);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `切换分支失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),

    qp.onDidHide(() => {
      disposables.forEach(d => d.dispose());
      qp.dispose();
    })
  );

  qp.show();
}

/** 显示仅含提示信息的 QuickPick，Enter 无操作。 */
function showInfoQuickPick(label: string): void {
  const qp = vscode.window.createQuickPick<BranchQuickPickItem>();
  qp.placeholder = label.replace(/\$\([^)]+\)\s*/, '');
  qp.items = [{ _kind: 'info', label, alwaysShow: true }];

  const disposables: vscode.Disposable[] = [];
  disposables.push(
    qp.onDidAccept(() => {
      qp.hide();
    }),
    qp.onDidHide(() => {
      disposables.forEach(d => d.dispose());
      qp.dispose();
    })
  );

  qp.show();
}
