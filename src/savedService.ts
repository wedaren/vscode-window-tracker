import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { normalizeSavedCandidate, normalizeSavedItem } from './helpers';
import { WindowNode, SavedItem } from './types';

/**
 * 管理 "已保存" 列表的存储和快照逻辑。
 *
 * 该类负责：
 *
 * 1. 从 `ExtensionContext.globalState` 初始化保存列表。
 * 2. 在内存中使用 Array + Set 组合以便快速查找和保留顺序。
 * 3. 将更新持久化到两个位置：
 *    - `globalState`（扩展数据存储）
 *    - tracker 目录下的 `saved.json`（用户可编辑）
 *
 * 此类与 DataManager 解耦，便于单独测试并在其他组件中复用。
 * 它只关心保存列表本身，不处理跟踪文件或 UI 表示。
 *
 * 使用示例：
 * ```ts
 * const svc = new SavedService(context, { trackerDir: '/path/to/dir' });
 * await svc.save('some-id');
 * const list = svc.getSavedArray();
 * ```
 */
export class SavedService {
  private savedFile = '';
  private savedArray: SavedItem[] = [];
  private savedSet: Set<string> = new Set();
  private readonly fsImpl: typeof fs;
  private loaded = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    options?: { fs?: typeof fs; trackerDir?: string }
  ) {
    this.fsImpl = options?.fs ?? fs;
    const trackerDir = options?.trackerDir ?? os.homedir();
    this.savedFile = path.join(trackerDir, 'saved.json');
    // Do not read from globalState for saved list; saved.json is authoritative.
    // savedArray will be loaded on demand by buildSavedNodes().
  }

  /**
   * @docs getSavedArray
   * 获取当前保存列表的拷贝。
   */
  public getSavedArray(): string[] {
    return this.savedArray.map(s => s.id);
  }

  /**
   * @docs getSavedItems
   * 返回当前保存条目的浅拷贝，供上层合并显示元数据。
   */
  public getSavedItems(): SavedItem[] {
    return [...this.savedArray];
  }

  /**
   * @docs persistSavedArray
   * 将保存数组持久化到 `globalState` 和磁盘 `saved.json` 文件。
   */
  public async persistSavedArray(arr: SavedItem[]): Promise<void> {
    this.savedArray = arr.map(item => ({
      id: item.id,
      lastActive: item.lastActive,
      keybinding: item.keybinding,
      displayName: item.displayName,
      color: item.color,
      pinned: item.pinned,
      openCount: item.openCount,
    }));
    this.savedSet = new Set(this.savedArray.map(s => s.id));
    this.loaded = true;
    try {
      // keep globalState as a mirror for quick access, but saved.json is source of truth
      await this.context.globalState.update('vscode-window-tracker.saved', this.savedArray);
    } catch {}
    void this.writeJson(this.savedFile, this.savedArray);
  }

  // 通过 tmp 文件原子写入 JSON
  private async writeJson(filePath: string, data: unknown): Promise<void> {
    try {
      const tmp = `${filePath}.tmp`;
      await this.fsImpl.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await this.fsImpl.rename(tmp, filePath);
    } catch {
      // ignore
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    try {
      const raw = await this.fsImpl.readFile(this.savedFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.savedArray = parsed
          .map(item => normalizeSavedItem(item))
          .filter((item): item is SavedItem => Boolean(item));
        this.savedSet = new Set(this.savedArray.map(s => s.id));
      }
    } catch {
      this.savedArray = [];
      this.savedSet = new Set();
    }
    this.loaded = true;
  }

  /**
   * @docs isSaved
   * 检查给定 id 是否已被保存。
   */
  public isSaved(id: string): boolean {
    return this.savedSet.has(id);
  }

  /**
   * @docs save
   * 将 id 添加到保存集合并持久化。
   */
  public async save(id: string): Promise<void> {
    await this.ensureLoaded();
    const now = Date.now();
    let found = false;
    this.savedArray = this.savedArray.map(s => {
      if (s.id === id) {
        found = true;
        return { ...s, id, lastActive: now };
      }
      return s;
    });
    if (!found) {
      this.savedArray.push({ id, lastActive: now });
    }
    this.savedSet = new Set(this.savedArray.map(s => s.id));
    await this.persistSavedArray(this.savedArray);
  }

  /**
   * @docs remove
   * 从保存集合移除 id 并持久化。
   */
  public async remove(id: string): Promise<void> {
    await this.ensureLoaded();
    if (this.savedSet.has(id)) {
      this.savedSet.delete(id);
      this.savedArray = this.savedArray.filter(s => s.id !== id);
      await this.persistSavedArray(this.savedArray);
    }
  }

  /**
   * @docs upsertMetadata
   * 更新或创建保存条目的展示元数据，并同步更新时间。
   */
  public async upsertMetadata(id: string, metadata: Partial<SavedItem>): Promise<void> {
    await this.ensureLoaded();
    const now = Date.now();
    let found = false;
    this.savedArray = this.savedArray.map(item => {
      if (item.id !== id) {
        return item;
      }
      found = true;
      return {
        ...item,
        lastActive: now,
        displayName: metadata.displayName,
        color: metadata.color,
        pinned: item.pinned,
        openCount: item.openCount,
      };
    });
    if (!found) {
      this.savedArray.push({
        id,
        lastActive: now,
        displayName: metadata.displayName,
        color: metadata.color,
      });
    }
    this.savedSet = new Set(this.savedArray.map(s => s.id));
    await this.persistSavedArray(this.savedArray);
  }

  /**
   * @docs getAllSaved
   * 返回保存集合中的所有 id。
   */
  public getAllSaved(): string[] {
    return [...this.savedSet];
  }

  /**
   * @docs setPinned
   * 设置指定 id 的置顶状态并持久化。
   */
  public async setPinned(id: string, pinned: boolean): Promise<void> {
    await this.ensureLoaded();
    this.savedArray = this.savedArray.map(item =>
      item.id === id ? { ...item, pinned: pinned || undefined } : item
    );
    await this.persistSavedArray(this.savedArray);
  }

  /**
   * @docs togglePinned
   * 切换指定 id 的置顶状态并持久化；返回新的置顶状态。
   */
  public async togglePinned(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const current = this.savedArray.find(i => i.id === id);
    const newPinned = !(current?.pinned ?? false);
    this.savedArray = this.savedArray.map(item =>
      item.id === id ? { ...item, pinned: newPinned || undefined } : item
    );
    await this.persistSavedArray(this.savedArray);
    return newPinned;
  }

  /**
   * @docs incrementOpenCount
   * 将指定 id 的 openCount 加一并持久化。
   */
  public async incrementOpenCount(id: string): Promise<void> {
    await this.ensureLoaded();
    let found = false;
    this.savedArray = this.savedArray.map(item => {
      if (item.id !== id) return item;
      found = true;
      return { ...item, openCount: (item.openCount ?? 0) + 1 };
    });
    if (!found) return;
    await this.persistSavedArray(this.savedArray);
  }

  /**
   * @docs buildSavedNodes
   * 将保存 id 列表转换为供树视图使用的 `WindowNode` 数组。
   */
  public async buildSavedNodes(): Promise<WindowNode[]> {
    await this.ensureLoaded();
    return this.savedArray.map(savedItem => normalizeSavedCandidate(savedItem));
  }

  /**
   * @docs updateLastActiveBatch
   * 批量更新已保存条目的 lastActive（仅当新值更大时）。
   */
  public async updateLastActiveBatch(updates: SavedItem[]): Promise<void> {
    if (!updates || updates.length === 0) return;
    let changed = false;
    const updateMap = new Map(updates.map(u => [u.id, u.lastActive]));
    this.savedArray = this.savedArray.map(item => {
      const next = updateMap.get(item.id);
      if (typeof next === 'number' && next > (item.lastActive ?? 0)) {
        changed = true;
        return { ...item, lastActive: next };
      }
      return item;
    });
    if (changed) {
      this.savedSet = new Set(this.savedArray.map(s => s.id));
      await this.persistSavedArray(this.savedArray);
    }
  }
}
