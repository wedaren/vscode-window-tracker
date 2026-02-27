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

  constructor(private readonly context: vscode.ExtensionContext, options?: { fs?: typeof fs; trackerDir?: string }) {
    this.fsImpl = options?.fs ?? fs;
    const trackerDir = options?.trackerDir ?? os.homedir();
    this.savedFile = path.join(trackerDir, 'saved.json');

    // fast initialize, ignore errors
    const stored = this.context.globalState.get<string[]>('vscode-window-tracker.saved', []);
    if (stored && stored.length) {
      this.savedArray = stored;
      this.savedSet = new Set(stored);
    }
  }

  public getSavedArray(): string[] {
    return [...this.savedArray];
  }

  public async persistSavedArray(arr: string[]): Promise<void> {
    this.savedArray = [...arr];
    this.savedSet = new Set(this.savedArray);
    try {
      await this.context.globalState.update('vscode-window-tracker.saved', this.savedArray);
    } catch {
      // ignore
    }
    void this.writeJson(this.savedFile, this.savedArray);
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    try {
      const tmp = `${filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmp, filePath);
    } catch {
      // ignore
    }
  }

  public isSaved(id: string): boolean {
    return this.savedSet.has(id);
  }

  public async save(id: string): Promise<void> {
    this.savedSet.add(id);
    await this.persistSavedArray([...this.savedSet]);
  }

  public async remove(id: string): Promise<void> {
    if (this.savedSet.has(id)) {
      this.savedSet.delete(id);
      await this.persistSavedArray([...this.savedSet]);
    }
  }

  public getAllSaved(): string[] {
    return [...this.savedSet];
  }

  public buildSavedNodes(trackedById?: Map<string, WindowNode>): WindowNode[] {
    return [...this.savedSet].map((savedId) =>
      normalizeSavedCandidate(savedId, trackedById?.get(savedId)?.lastActive)
    );
  }
}
