import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * 管理 "已保存" 列表的存储和快照逻辑。
 *
 * 该类负责从 globalState 初始化列表，维护内存中的 Array + Set
 * 表示，并提供持久化到两个位置的方法：globalState 与用户可写的
 * saved.json 文件。原 DataManager 中的同名逻辑已移至此处，使业务
 * 关注点更清晰。
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

  public buildSavedNodes(trackedById?: Map<string, import('./types').WindowNode>): import('./types').WindowNode[] {
    return [...this.savedSet].map((savedId) => 
      import('./helpers').normalizeSavedCandidate(savedId, trackedById?.get(savedId)?.lastActive)
    );
  }
}
