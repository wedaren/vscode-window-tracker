import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export type WindowRecord = {
  title?: string;
  path?: string;
  uri?: string;
  pid?: number;
  windowId?: number | string;
  lastActive?: number;
  source?: string;
  status?: string;
};

export class DataManager {
  private addedFile = '';
  private savedFile = '';
  private trackedFile = '';
  private savedArray: string[] = [];
  constructor(private readonly context: vscode.ExtensionContext) {
    try {
      void fs.mkdir(this.context.globalStoragePath, { recursive: true });
    } catch {
      // ignore
    }
    // Paths for backward-compatible storage and new 'saved' file
    this.addedFile = path.join(this.context.globalStoragePath || os.homedir(), 'added.json');
    this.trackedFile = path.join(this.context.globalStoragePath || os.homedir(), 'tracked.json');

    // Prefer storing the editable `saved.json` inside the user-visible
    // tracker directory so users can batch-edit it. Use configured
    // `vscode-window-tracker.trackerDir` (default ~/.vscode-window-tracker).
    try {
      const rawTracker = this.getConfig<string>('trackerDir', '~/.vscode-window-tracker');
      const trackerDir = rawTracker.replace(/^~(?=$|\/|\\)/, os.homedir());
      void (async () => {
        try {
          await fs.mkdir(trackerDir, { recursive: true });
        } catch {
          // ignore
        }
      })();
      this.savedFile = path.join(trackerDir, 'saved.json');
    } catch {
      // fallback to extension storage
      this.savedFile = path.join(this.context.globalStoragePath || os.homedir(), 'saved.json');
    }

    // Try to load the new 'saved' key first; fall back to legacy 'added' key/file and migrate.
    const storedSaved = this.context.globalState.get<string[]>('vscode-window-tracker.saved', []);
    if (storedSaved && storedSaved.length) {
      this.savedArray = storedSaved;
    } else {
      void (async () => {
        // 1) try saved.json file
        try {
          const content = await fs.readFile(this.savedFile, 'utf8');
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            this.savedArray = parsed;
            await this.context.globalState.update('vscode-window-tracker.saved', this.savedArray);
            return;
          }
        } catch {
          // ignore
        }
        // 2) try legacy globalState key 'vscode-window-tracker.added'
        try {
          const legacy = this.context.globalState.get<string[]>('vscode-window-tracker.added', []);
          if (legacy && legacy.length) {
            this.savedArray = legacy;
            await this.context.globalState.update('vscode-window-tracker.saved', this.savedArray);
            void this.writeJson(this.savedFile, this.savedArray);
            return;
          }
        } catch {
          // ignore
        }
        // 3) try legacy added.json file
        try {
          const content = await fs.readFile(this.addedFile, 'utf8');
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            this.savedArray = parsed;
            await this.context.globalState.update('vscode-window-tracker.saved', this.savedArray);
            void this.writeJson(this.savedFile, this.savedArray);
          }
        } catch {
          // ignore
        }
      })();
    }
  }

  // Primary API now uses 'saved' naming and persists to saved.json
  public getSavedArray(): string[] {
    return [...this.savedArray];
  }

  public async persistSavedArray(arr: string[]): Promise<void> {
    this.savedArray = [...arr];
    try {
      await this.context.globalState.update('vscode-window-tracker.saved', this.savedArray);
    } catch {
      // ignore
    }
    void this.writeJson(this.savedFile, this.savedArray);
  }

  // Backwards-compatible wrappers for older API names
  public getAddedArray(): string[] {
    return this.getSavedArray();
  }

  public async persistAddedArray(arr: string[]): Promise<void> {
    return this.persistSavedArray(arr);
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

  private getConfig<T = any>(key: string, fallback?: T): T {
    const cfg = vscode.workspace.getConfiguration('vscode-window-tracker');
    const val = cfg.get<T>(key as any);
    return (val === undefined ? (fallback as T) : val) as T;
  }

  public buildDedupKeys(record: WindowRecord): string[] {
    const uriOrPath = record.uri || record.path || 'unknown';
    const windowId = record.windowId ?? 'none';
    const pid = record.pid ?? 'none';
    const title = (record.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return [`${uriOrPath}::${windowId}`, `${uriOrPath}::${pid}`, `title::${title}`];
  }

  public async loadAllRecords(): Promise<WindowRecord[]> {
    const preferDaemon = this.getConfig<boolean>('preferDaemon', false);
    const fromDaemon = preferDaemon ? await this.loadDaemonFile() : [];
    if (fromDaemon && fromDaemon.length) {
      return this.dedupe(fromDaemon);
    }
    const fromTracker = await this.loadTrackerFiles();
    const fromWorkspace = this.loadCurrentWorkspaceRecord();
    return this.dedupe([fromWorkspace, ...fromTracker]);
  }

  private async loadDaemonFile(): Promise<WindowRecord[]> {
    const rawPath = this.getConfig<string>('daemonFile', '~/.vscode-window-daemon.json');
    const expanded = rawPath.replace(/^~(?=$|\/|\\)/, os.homedir());
    try {
      const content = await fs.readFile(expanded, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return parsed as WindowRecord[];
      if (parsed && Array.isArray(parsed.windows)) return parsed.windows as WindowRecord[];
      if (parsed && typeof parsed === 'object') return [parsed as WindowRecord];
      return [];
    } catch {
      return [];
    }
  }

  private loadCurrentWorkspaceRecord(): WindowRecord {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const folderPath = workspaceFolder?.uri.fsPath;
    return {
      title: vscode.window.activeTextEditor?.document.fileName ? path.basename(vscode.window.activeTextEditor.document.fileName) : 'Current Workspace',
      path: folderPath,
      uri: workspaceFolder?.uri.toString(),
      lastActive: Date.now(),
      source: 'vscode',
      status: 'focused',
    };
  }

  private async loadTrackerFiles(): Promise<WindowRecord[]> {
    const raw = this.getConfig<string>('trackerDir', '~/.vscode-window-tracker');
    const trackerDir = raw.replace(/^~(?=$|\/|\\)/, os.homedir());
    const staleMinutes = this.getConfig<number>('trackerFileStaleMinutes', 30);
    const cutoff = Date.now() - (staleMinutes ?? 30) * 60 * 1000;
    try {
      const files = await fs.readdir(trackerDir);
      const jsonFiles = files.filter((file) => file.endsWith('.json'));
      const records = await Promise.all(jsonFiles.map(async (file) => {
        const filePath = path.join(trackerDir, file);
        try {
          const content = await fs.readFile(filePath, 'utf8');
          const raw = JSON.parse(content);
          const candidate = Array.isArray(raw) ? raw : (raw && raw.windows ? raw.windows : [raw]);
          if (Array.isArray(candidate)) {
            const filtered = candidate.filter((r: any) => {
              if (!r || typeof r !== 'object') return false;
              if (typeof r.lastActive === 'number') return r.lastActive >= cutoff;
              return true;
            });
            // write tracked snapshot
            void (async () => {
              try {
                const snap = filtered.map((r: any) => ({ stableId: (r.uri || r.path || r.title || '').toString(), title: r.title, path: r.path, uri: r.uri, lastActive: r.lastActive, status: r.status }));
                await this.writeJson(this.trackedFile, snap);
              } catch { }
            })();
            return filtered as WindowRecord[];
          }
          return [];
        } catch {
          return [];
        }
      }));
      return records.flat();
    } catch {
      return [];
    }
  }

  private dedupe(records: WindowRecord[]): WindowRecord[] {
    const map = new Map<string, WindowRecord>();
    for (const record of records) {
      const keys = this.buildDedupKeys(record);
      const winnerKey = keys.find((key) => map.has(key));
      if (winnerKey) {
        const current = map.get(winnerKey)!;
        if ((record.lastActive ?? 0) > (current.lastActive ?? 0)) {
          map.set(winnerKey, record);
        }
        continue;
      }
      map.set(keys[0], record);
    }
    return [...map.values()];
  }
}

export function createDataManager(ctx: vscode.ExtensionContext) {
  return new DataManager(ctx);
}
