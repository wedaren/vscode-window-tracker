import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { normalizeSavedCandidate } from './helpers';
import { WindowNode } from './types';

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
  private savedArray: string[] = [];
  private savedSet: Set<string> = new Set();
  private readonly fsImpl: typeof fs;

  constructor(
    private readonly context: vscode.ExtensionContext,
    options?: { fs?: typeof fs; trackerDir?: string }
  ) {
    this.fsImpl = options?.fs ?? fs;
    const trackerDir = options?.trackerDir ?? os.homedir();
    this.savedFile = path.join(trackerDir, 'saved.json');

    const stored = this.context.globalState.get<string[]>('vscode-window-tracker.saved', []);
    if (stored && stored.length) {
      this.savedArray = stored;
      this.savedSet = new Set(stored);
    }
  }

  /**
   * @docs getSavedArray
   * 获取当前保存列表的拷贝。
   */
  public getSavedArray(): string[] {
    return [...this.savedArray];
  }

  /**
   * @docs persistSavedArray
   * 将保存数组持久化到 `globalState` 和磁盘 `saved.json` 文件。
   */
  public async persistSavedArray(arr: string[]): Promise<void> {
    this.savedArray = [...arr];
    this.savedSet = new Set(this.savedArray);
    try {
      await this.context.globalState.update('vscode-window-tracker.saved', this.savedArray);
    } catch {}
    void this.writeJson(this.savedFile, this.savedArray);
  }

  // 通过 tmp 文件原子写入 JSON
  private async writeJson(filePath: string, data: unknown): Promise<void> {
    try {
      const tmp = `${filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmp, filePath);
    } catch {
      // ignore
    }
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
    this.savedSet.add(id);
    await this.persistSavedArray([...this.savedSet]);
  }

  /**
   * @docs remove
   * 从保存集合移除 id 并持久化。
   */
  public async remove(id: string): Promise<void> {
    if (this.savedSet.has(id)) {
      this.savedSet.delete(id);
      await this.persistSavedArray([...this.savedSet]);
    }
  }

  /**
   * @docs getAllSaved
   * 返回保存集合中的所有 id。
   */
  public getAllSaved(): string[] {
    return [...this.savedSet];
  }

  /**
   * @docs buildSavedNodes
   * 将保存 id 列表转换为供树视图使用的 `WindowNode` 数组。
   */
  public buildSavedNodes(): WindowNode[] {
    return [...this.savedSet].map(savedId =>
      normalizeSavedCandidate(savedId)
    );
  }
}
