import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { toRelativeTime } from './helpers';

// globalState 键沿用旧的 viewsNavigator 前缀，保证已存数据（置顶/隐藏/备注/MRU）不丢失
const PINNED_KEY = 'viewsNavigator:pinned';
const HIDDEN_KEY = 'viewsNavigator:hidden';
const NOTES_KEY = 'viewsNavigator:notes';
const RECENT_KEY = 'viewsNavigator:recent';

interface ViewDef {
  id: string;
  name: string;
  icon?: string;
  extension?: string; // undefined = 内置
}

interface ViewQuickPickItem extends vscode.QuickPickItem {
  _viewId: string;
  _pinned: boolean;
}

// ─── 内置视图白名单 ───

const BUILTIN_VIEWS: ViewDef[] = [
  { id: 'workbench.view.explorer', name: 'Explorer', icon: 'files' },
  { id: 'workbench.view.search', name: 'Search', icon: 'search' },
  { id: 'workbench.view.scm', name: 'Source Control', icon: 'source-control' },
  { id: 'workbench.view.debug', name: 'Run and Debug', icon: 'debug-alt' },
  { id: 'workbench.view.extensions', name: 'Extensions', icon: 'extensions' },
  { id: 'workbench.view.testing', name: 'Testing', icon: 'beaker' },
  { id: 'outline', name: 'Outline', icon: 'list-tree' },
  { id: 'timeline', name: 'Timeline', icon: 'history' },
];

// ─── 补充视图（本插件 TreeView + 兜底）───

const SUPPLEMENTARY_VIEWS: ViewDef[] = [
  { id: 'vscode-window-tracker.windowsView', name: 'Window Tracker', icon: 'window', extension: '本插件' },
  { id: 'vscode-window-tracker.editorsView', name: 'Editors', icon: 'list-flat', extension: '本插件' },
  { id: 'vscode-window-tracker.branchesView', name: 'Branches', icon: 'git-branch', extension: '本插件' },
];

// ─── Pin 辅助 ───

function getPinned(context: vscode.ExtensionContext): string[] {
  return context.globalState.get<string[]>(PINNED_KEY, []);
}

async function togglePin(context: vscode.ExtensionContext, viewId: string): Promise<boolean> {
  const pinned = getPinned(context);
  const idx = pinned.indexOf(viewId);
  const next = idx >= 0 ? pinned.filter(id => id !== viewId) : [...pinned, viewId];
  await context.globalState.update(PINNED_KEY, next);
  return idx < 0; // true = 刚 pin 上
}

// ─── 扫描扩展目录 ───

async function scanExtensionViews(): Promise<ViewDef[]> {
  const results: ViewDef[] = [];
  const isInsiders = vscode.env.appName.includes('Insiders');
  const codeDir = isInsiders ? '.vscode-insiders' : '.vscode';
  const extensionsDir = path.join(os.homedir(), codeDir, 'extensions');

  let entries: string[] = [];
  try {
    entries = await fs.readdir(extensionsDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const pkgPath = path.join(extensionsDir, entry, 'package.json');
    try {
      const stat = await fs.stat(path.join(extensionsDir, entry));
      if (!stat.isDirectory()) continue;

      const pkgRaw = await fs.readFile(pkgPath, 'utf8');
      const pkg = JSON.parse(pkgRaw) as {
        name?: string;
        displayName?: string;
        contributes?: {
          views?: Record<string, Array<{ id?: string; name?: string }>>;
        };
      };

      const viewsMap = pkg.contributes?.views;
      if (!viewsMap) continue;

      const extName = pkg.displayName || pkg.name || entry;

      for (const views of Object.values(viewsMap)) {
        for (const view of views) {
          if (!view.id) continue;
          const viewName = view.name || view.id;
          // 跳过未解析的本地化占位符
          if (viewName.includes('%') || extName.includes('%')) continue;
          results.push({
            id: view.id,
            name: viewName,
            extension: extName,
          });
        }
      }
    } catch {
      // ignore unreadable extensions
    }
  }

  return results;
}

// ─── 合并 + 去重 + 重名处理 ───

function mergeViews(extensionViews: ViewDef[]): ViewDef[] {
  const all: ViewDef[] = [...BUILTIN_VIEWS, ...SUPPLEMENTARY_VIEWS, ...extensionViews];

  // 按 id 去重（前面的优先级高）
  const seen = new Set<string>();
  const unique = all.filter(v => {
    if (seen.has(v.id)) return false;
    seen.add(v.id);
    return true;
  });

  return unique;
}

function detectDuplicateNames(views: ViewDef[]): Set<string> {
  const count = new Map<string, number>();
  for (const v of views) {
    count.set(v.name, (count.get(v.name) || 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [name, c] of count) {
    if (c > 1) duplicates.add(name);
  }
  return duplicates;
}

// ─── 构建 QuickPick 项 ───

function buildQuickPickItems(
  views: ViewDef[],
  pinnedIds: string[],
  notes: Record<string, string>,
  recentMap: Record<string, number>
): ViewQuickPickItem[] {
  const dupNames = detectDuplicateNames(views);

  const makeItem = (v: ViewDef): ViewQuickPickItem => {
    const isPinned = pinnedIds.includes(v.id);
    const hasDup = dupNames.has(v.name);
    const lastUsed = recentMap[v.id];

    const iconPrefix = v.icon ? `$(${v.icon}) ` : '';
    const pinPrefix = isPinned ? '$(pinned) ' : '';
    const label = `${pinPrefix}${iconPrefix}${v.name}`;

    // description：扩展名 + 备注 + 相对时间
    const descParts: string[] = [];
    if (hasDup) descParts.push(v.extension || '内置');
    else descParts.push(v.extension || '内置');
    if (notes[v.id]) descParts.push(`📝 ${notes[v.id]}`);
    if (lastUsed) descParts.push(toRelativeTime(lastUsed));
    const description = descParts.join(' · ');
    const detail = hasDup ? `ID: ${v.id}` : undefined;

    return {
      label,
      description,
      detail,
      _viewId: v.id,
      _pinned: isPinned,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon('edit'),
          tooltip: '编辑备注',
        },
        {
          iconPath: new vscode.ThemeIcon(isPinned ? 'pinned' : 'pin'),
          tooltip: isPinned ? '取消置顶' : '置顶',
        },
      ],
    };
  };

  const pinned = views.filter(v => pinnedIds.includes(v.id)).map(makeItem);
  const unpinned = views.filter(v => !pinnedIds.includes(v.id)).map(makeItem);

  const items: ViewQuickPickItem[] = [];

  if (pinned.length > 0) {
    items.push({
      label: '已置顶',
      kind: vscode.QuickPickItemKind.Separator,
      _viewId: '',
      _pinned: false,
    });
    items.push(...pinned);
  }

  if (unpinned.length > 0) {
    items.push({
      label: pinned.length > 0 ? '其他视图' : '视图列表',
      kind: vscode.QuickPickItemKind.Separator,
      _viewId: '',
      _pinned: false,
    });
    items.push(...unpinned);
  }

  return items;
}

// ─── 入口 ───

export async function openViewsQuickPick(
  context: vscode.ExtensionContext
): Promise<void> {
  // 1. 扫描扩展
  const extViews = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '正在扫描已安装扩展的视图...',
      cancellable: false,
    },
    () => scanExtensionViews()
  );

  // 2. 合并 + 去重
  const allViews = mergeViews(extViews);

  // 3. 读取 pinned
  let pinnedIds = getPinned(context);

  // 4. 过滤掉已不存在的 pinned
  const validPinned = pinnedIds.filter(id => allViews.some(v => v.id === id));
  if (validPinned.length !== pinnedIds.length) {
    pinnedIds = validPinned;
    await context.globalState.update(PINNED_KEY, pinnedIds);
  }

  // 5. 读取 hidden、notes、recent
  const hiddenIds = context.globalState.get<string[]>(HIDDEN_KEY, []);
  const notes = context.globalState.get<Record<string, string>>(NOTES_KEY, {});
  const recentMap = context.globalState.get<Record<string, number>>(RECENT_KEY, {});

  // 排序：pinned → MRU（最近使用）→ 其余按名称
  const pinnedViews = pinnedIds
    .map(id => allViews.find(v => v.id === id)!)
    .filter(Boolean);

  const unpinnedVisible = allViews.filter(v => !pinnedIds.includes(v.id) && !hiddenIds.includes(v.id));
  const mruViews = unpinnedVisible
    .filter(v => recentMap[v.id])
    .sort((a, b) => (recentMap[b.id] || 0) - (recentMap[a.id] || 0));
  const mruIds = new Set(mruViews.map(v => v.id));
  const restViews = unpinnedVisible
    .filter(v => !mruIds.has(v.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  const sortedViews = [...pinnedViews, ...mruViews, ...restViews];

  // 6. 构建 QuickPick
  const qp = vscode.window.createQuickPick<ViewQuickPickItem>();
  qp.placeholder = `选择视图并按 Enter 聚焦 · 已隐藏 ${hiddenIds.length} 项` + (hiddenIds.length > 0 ? ' · 可在 Views 面板中管理' : '');
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;

  function refreshItems() {
    qp.items = buildQuickPickItems(sortedViews, pinnedIds, notes, recentMap);
  }

  refreshItems();

  const disposables: vscode.Disposable[] = [];

  disposables.push(
    // 点击 pin 按钮
    qp.onDidTriggerItemButton(async event => {
      const item = event.item;
      if (item.kind === vscode.QuickPickItemKind.Separator) return;

      const buttonTooltip = (event.button as vscode.QuickInputButton).tooltip;

      // ─── 编辑备注 ───
      if (buttonTooltip === '编辑备注') {
        const viewName = allViews.find(v => v.id === item._viewId)?.name || item._viewId;
        const currentNote = notes[item._viewId] || '';
        const note = await vscode.window.showInputBox({
          prompt: `为 ${viewName} 添加备注`,
          value: currentNote,
          placeHolder: '输入备注，留空清除',
        });
        if (note === undefined) return; // 用户取消
        if (note.trim()) {
          notes[item._viewId] = note.trim();
        } else {
          delete notes[item._viewId];
        }
        await context.globalState.update(NOTES_KEY, notes);
        refreshItems();
        void vscode.window.showInformationMessage(
          note.trim() ? `已添加备注：${note.trim()}` : '已清除备注'
        );
        return;
      }

      // ─── 置顶/取消置顶 ───
      const nowPinned = await togglePin(context, item._viewId);
      pinnedIds = getPinned(context);

      // 重新排序
      const newPinned = pinnedIds
        .map(id => sortedViews.find(v => v.id === id)!)
        .filter(Boolean);
      const newOther = sortedViews
        .filter(v => !pinnedIds.includes(v.id))
        .sort((a, b) => a.name.localeCompare(b.name));
      sortedViews.length = 0;
      sortedViews.push(...newPinned, ...newOther);

      refreshItems();

      const viewName = allViews.find(v => v.id === item._viewId)?.name || item._viewId;
      void vscode.window.showInformationMessage(
        nowPinned ? `已置顶：${viewName}` : `已取消置顶：${viewName}`
      );
    }),

    // 确认选择
    qp.onDidAccept(async () => {
      const picked = qp.selectedItems[0];
      if (!picked || picked.kind === vscode.QuickPickItemKind.Separator) return;
      qp.hide();

      // 记录 MRU（最近使用时间戳）
      recentMap[picked._viewId] = Date.now();
      await context.globalState.update(RECENT_KEY, recentMap);

      // 聚焦到视图：先尝试打开容器，再 focus 视图
      try {
        await vscode.commands.executeCommand(`${picked._viewId}.focus`);
      } catch {
        // fallback：直接执行 viewId（内置容器命令）
        await vscode.commands.executeCommand(picked._viewId);
      }
    }),

    qp.onDidHide(() => {
      disposables.forEach(d => d.dispose());
      qp.dispose();
    })
  );

  qp.show();
}
