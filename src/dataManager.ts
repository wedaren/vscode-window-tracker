import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WindowNode } from './types';
import { buildDedupKeys, toRelativeTime, normalizeSavedCandidate } from './helpers';

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
  private savedSet: Set<string> = new Set();
  private tracker?: TrackerService;
  private readonly fsImpl: typeof fs = fs;

  constructor(private readonly context: vscode.ExtensionContext, options?: { fs?: typeof fs }) {
    this.fsImpl = options?.fs ?? fs;
    try {
      void this.fsImpl.mkdir(this.context.globalStoragePath, { recursive: true });
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
          await this.fsImpl.mkdir(trackerDir, { recursive: true });
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
          const content = await this.fsImpl.readFile(this.savedFile, 'utf8');
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
          const content = await this.fsImpl.readFile(this.addedFile, 'utf8');
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
    this.savedSet = new Set(this.savedArray);
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

  /**
   * Read an individual extension configuration value, providing a default
   * when the key is absent.  Exposed publicly so that UI components (such as
   * the tree provider) can avoid duplicating config logic.
   */
  public getConfig<T = any>(key: string, fallback?: T): T {
    const cfg = vscode.workspace.getConfiguration('vscode-window-tracker');
    const val = cfg.get<T>(key as any);
    return (val === undefined ? (fallback as T) : val) as T;
  }

  public buildDedupKeys(record: WindowRecord): string[] {
    // wrapper preserved for backwards compatibility
    return buildDedupKeys(record);
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
      const files = await this.fsImpl.readdir(trackerDir);
      const jsonFiles = files.filter((file) => file.endsWith('.json'));
      const records = await Promise.all(jsonFiles.map(async (file) => {
        const filePath = path.join(trackerDir, file);
        try {
          const content = await this.fsImpl.readFile(filePath, 'utf8');
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

  // ---------- saved set helpers ----------
  public isSaved(stableId: string): boolean {
    return this.savedSet.has(stableId);
  }

  public async save(stableId: string): Promise<void> {
    this.savedSet.add(stableId);
    await this.persistSavedArray([...this.savedSet]);
  }

  public async removeSaved(stableId: string): Promise<void> {
    if (this.savedSet.has(stableId)) {
      this.savedSet.delete(stableId);
      await this.persistSavedArray([...this.savedSet]);
    }
  }

  public getAllSaved(): string[] {
    return [...this.savedSet];
  }

  public buildSavedNodes(trackedById?: Map<string, WindowNode>): WindowNode[] {
    return [...this.savedSet].map((savedId) => this.normalizeSavedCandidate(savedId, trackedById?.get(savedId)?.lastActive));
  }

  private normalizeSavedCandidate(savedId: string, lastActiveOverride?: number): WindowNode {
    return normalizeSavedCandidate(savedId, lastActiveOverride);
  }

  // ---------- tracked helpers ----------
  public normalizeTrackedNodes(records: WindowRecord[]): WindowNode[] {
    const now = Date.now();
    const enriched: WindowNode[] = records.map((record, index) => {
      const stableId = (buildDedupKeys(record) || [])[0] || `${record.path || record.title || 'window'}-${index}`;
      let dirUri: vscode.Uri | undefined = undefined;
      if (record.uri) {
        try {
          dirUri = vscode.Uri.parse(record.uri);
        } catch {
          dirUri = undefined;
        }
      } else if (record.path) {
        try {
          dirUri = vscode.Uri.file(record.path);
        } catch {
          dirUri = undefined;
        }
      }
      const lastActive = record.lastActive ?? now;
      return {
        type: 'window',
        ...record,
        stableId,
        origin: 'tracked',
        dirUri,
        relativeActive: toRelativeTime(lastActive, now),
      } as WindowNode;
    });

    const sorted = enriched.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
    return sorted;
  }


  // ---------- combined node list ----------
  public async getWindowNodes(): Promise<WindowNode[]> {
    const loaded = await this.loadAllRecords();
    const trackedNodes = this.normalizeTrackedNodes(loaded);
    const trackedById = new Map(trackedNodes.map(n => [n.stableId, n]));
    let addedNodes = this.buildSavedNodes(trackedById);
    const standaloneAdded: WindowNode[] = [];
    for (const a of addedNodes) {
      const t = trackedById.get(a.stableId);
      if (t) {
        t.isSaved = true;
      } else {
        standaloneAdded.push(a);
      }
    }
    addedNodes = standaloneAdded;
    const nodes = [...trackedNodes, ...addedNodes].sort((a, b) => {
      if (a.origin !== b.origin) return a.origin === 'tracked' ? -1 : 1;
      return (b.lastActive ?? 0) - (a.lastActive ?? 0);
    });
    return nodes;
  }

  // ---------- tracker helpers delegated to internal class ----------
  public startTracker(): void {
    if (!this.tracker) {
      this.tracker = new TrackerService(this.context, { fs: this.fsImpl });
    }
    this.tracker.start();
  }

  public stopTracker(): void {
    if (this.tracker) {
      this.tracker.stop();
      this.tracker = undefined;
    }
  }
}

export function createDataManager(ctx: vscode.ExtensionContext, options?: { fs?: typeof fs }) {
  return new DataManager(ctx, options);
}

// internal tracker class copied from previous trackerService.ts; used only by DataManager
class TrackerService {
    private context: vscode.ExtensionContext;
    private trackerDir: string;
    private trackerFilePath: string | undefined;
    private heartbeatSeconds: number;
    private staleMinutes: number;
    private autoCleanup: boolean;
    private timer: NodeJS.Timeout | undefined;
    private windowStateListener: vscode.Disposable | undefined;
    private activeEditorListener: vscode.Disposable | undefined;
    private boundExitHandler: () => void;
    private boundSigintHandler: () => void;
    private boundSigtermHandler: () => void;
    private boundUncaughtHandler: (error: Error) => void;

    // allow injecting an fs-like implementation for testing
    private readonly fsImpl: typeof fs = fs;

    constructor(context: vscode.ExtensionContext, options?: { fs?: typeof fs }) {
        this.context = context;
        this.fsImpl = options?.fs ?? fs;
        const cfg = vscode.workspace.getConfiguration('vscode-window-tracker');
        const rawTrackerDir = cfg.get<string>('trackerDir', '~/.vscode-window-tracker')!;
        this.trackerDir = rawTrackerDir.replace(/^~(?=$|\/|\\)/, os.homedir());
        this.heartbeatSeconds = cfg.get<number>('heartbeatIntervalSeconds', 5) ?? 5;
        this.staleMinutes = cfg.get<number>('trackerFileStaleMinutes', 30) ?? 30;
        this.autoCleanup = cfg.get<boolean>('trackerAutoCleanup', true) ?? true;

        this.trackerFilePath = undefined;

        this.boundExitHandler = () => {
            if (this.trackerFilePath) {
            try {
                // The 'exit' handler must be synchronous.
                require('fs').unlinkSync(this.trackerFilePath);
            } catch {
                // ignore, file might not exist
            }
            }
        };
        this.boundSigintHandler = () => { process.exit(130); };
        this.boundSigtermHandler = () => { process.exit(137); };
        this.boundUncaughtHandler = (error: Error) => {
            // eslint-disable-next-line no-console
            console.error('Uncaught exception:', error);
            process.exit(1);
        };
    }

    start(): void {
        void this.startupCleanup();
        // initial write
        void this.writeNow();

        // heartbeat
        this.timer = setInterval(() => { void this.writeNow(); }, this.heartbeatSeconds * 1000);

        // window/editor listeners
        this.windowStateListener = vscode.window.onDidChangeWindowState(() => void this.writeNow());
        this.activeEditorListener = vscode.window.onDidChangeActiveTextEditor(() => void this.writeNow());

        // process signals
        process.on('exit', this.boundExitHandler);
        process.on('SIGINT', this.boundSigintHandler);
        process.on('SIGTERM', this.boundSigtermHandler);
        process.on('uncaughtException', this.boundUncaughtHandler);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        if (this.windowStateListener) {
            this.windowStateListener.dispose();
            this.windowStateListener = undefined;
        }
        if (this.activeEditorListener) {
            this.activeEditorListener.dispose();
            this.activeEditorListener = undefined;
        }
        try { process.off('exit', this.boundExitHandler); } catch { }
        try { process.off('SIGINT', this.boundSigintHandler); } catch { }
        try { process.off('SIGTERM', this.boundSigtermHandler); } catch { }
        try { process.off('uncaughtException', this.boundUncaughtHandler); } catch { }

        void this.removeNow();
    }

    async ensureDir(): Promise<void> {
        try {
            await this.fsImpl.mkdir(this.trackerDir, { recursive: true });
        } catch {
            // ignore
        }
    }

    async writeNow(): Promise<void> {
        await this.ensureDir();
        // If we have a stored tracker file path, validate ownership before reusing it.
        if (this.trackerFilePath) {
            try {
                const existing = await this.fsImpl.readFile(this.trackerFilePath, 'utf8');
                try {
                    const parsed = JSON.parse(existing);
                    // If the file is owned by another process, don't reuse it.
                    if (parsed && typeof parsed.pid === 'number' && parsed.pid !== process.pid) {
                        this.trackerFilePath = undefined;
                    }
                } catch {
                    // If parse fails, don't trust the file — create a new one.
                    this.trackerFilePath = undefined;
                }
            } catch {
                // Can't read the file (missing/unreadable) — create a new one.
                this.trackerFilePath = undefined;
            }
        }

        if (!this.trackerFilePath) {
            const fname = `vscode-${process.pid}-${Date.now()}.json`;
            this.trackerFilePath = path.join(this.trackerDir, fname);
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const folderPath = workspaceFolder?.uri.fsPath;
        const status = vscode.window.state.focused ? 'focused' : 'visible';

        // Determine lastActive such that it represents the last time the
        // window was focused. Do not update lastActive on periodic heartbeats
        // when the window is not focused — preserve the existing value if any.
        let lastActiveValue = Date.now();
        if (status !== 'focused') {
            // Try to read existing tracker file to reuse prior lastActive
            try {
                const existingPath = this.trackerFilePath ?? (await this.context.globalState.get('vscode-window-tracker.trackerFile')) as string | undefined;
                if (existingPath) {
                    const existing = await this.fsImpl.readFile(existingPath, 'utf8').catch(() => undefined);
                    if (existing) {
                        try {
                            const parsed = JSON.parse(existing);
                            if (parsed && typeof parsed.lastActive === 'number') {
                                lastActiveValue = parsed.lastActive;
                            }
                        } catch {
                            // ignore parse errors and keep now as fallback
                        }
                    }
                }
            } catch {
                // ignore read errors
            }
        }

        const rec = {
            title: vscode.window.activeTextEditor?.document.fileName ? path.basename(vscode.window.activeTextEditor.document.fileName) : 'Current Workspace',
            path: folderPath,
            uri: workspaceFolder?.uri.toString(),
            pid: process.pid,
            lastActive: lastActiveValue,
            source: 'vscode-extension',
            status,
        };

        try {
            const tmp = `${this.trackerFilePath}.tmp`;
            await this.fsImpl.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
            await this.fsImpl.rename(tmp, this.trackerFilePath);
            // persist the chosen tracker file path to globalState so it can be
            // cleaned up or reused by subsequent runs/tests
            try {
                await this.context.globalState.update('vscode-window-tracker.trackerFile', this.trackerFilePath);
            } catch {
                // ignore failures to update global state in environments where it's not available
            }
        } catch (e) {
            // Keep parity with previous behavior: log but don't throw
            // eslint-disable-next-line no-console
            console.error('Failed to write tracker file', e);
        }
    }

    async removeNow(): Promise<void> {
        if (!this.trackerFilePath) {
            // Try to recover the stored tracker path from globalState (useful
            // in tests or across runs where the service wasn't the one that
            // created the file in this process).
            try {
                const stored = await this.context.globalState.get('vscode-window-tracker.trackerFile');
                if (typeof stored === 'string') {
                    this.trackerFilePath = stored;
                }
            } catch {
                // ignore
            }
        }
        if (!this.trackerFilePath) return;
        try {
            await this.fsImpl.unlink(this.trackerFilePath);
        } catch {
            // ignore
        }
        this.trackerFilePath = undefined;
        try {
            await this.context.globalState.update('vscode-window-tracker.trackerFile', undefined);
        } catch {
            // ignore
        }
    }

    private async startupCleanup(): Promise<void> {
        if (!this.autoCleanup) return;
        try {
            const cutoff = Date.now() - this.staleMinutes * 60 * 1000;
            const files = await this.fsImpl.readdir(this.trackerDir).catch(() => []);
            for (const f of files) {
                if (!f.endsWith('.json')) continue;
                const fp = path.join(this.trackerDir, f);
                try {
                    const c = await this.fsImpl.readFile(fp, 'utf8');
                    const parsed = JSON.parse(c);
                    const last = parsed && typeof parsed.lastActive === 'number' ? parsed.lastActive : undefined;
                    if (last && last < cutoff) {
                        await this.fsImpl.unlink(fp).catch(() => {});
                    }
                } catch {
                    // ignore parse/read errors
                }
            }
        } catch {
            // ignore
        }
    }
}

// --------- view helper functions (previously in viewHelpers.ts) ----------

/**
 * Determine how the given record should be displayed as a tree item title.
 * Prefers file/uri basename, falls back to the raw title string.
 */
export function formatTitle(node: WindowNode): string {
  if (node.path) {
    return path.basename(node.path);
  }
  if (node.uri) {
    try {
      const u = vscode.Uri.parse(node.uri);
      return path.basename(u.fsPath) || path.posix.basename(u.path) || u.toString();
    } catch {
      // ignore
    }
  }
  return node.title || 'Untitled Window';
}

/**
 * Generate a brief description shown to the right of a tree item.
 */
export function buildDescription(node: WindowNode): string {
  return `${node.relativeActive}`;
}

/**
 * Build the markdown tooltip for an item.
 */
export function buildTooltip(node: WindowNode): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${node.title || 'Untitled Window'}**\n\n`);
  md.appendMarkdown(`- path: ${node.path || '-'}\n`);
  md.appendMarkdown(`- pid: ${node.pid ?? '-'}\n`);
  md.appendMarkdown(`- lastActive: ${node.lastActive ? new Date(node.lastActive).toLocaleString() : '-'}\n`);
  md.appendMarkdown(`- source: ${node.source || '-'}\n`);
  md.appendMarkdown(`- status(raw): ${node.status || '-'}\n`);
  md.isTrusted = false;
  return md;
}

/**
 * Context value string used for menu contributions.
 */
export function buildContextValue(node: WindowNode): string {
  if (node.origin === 'saved') {
    return 'windowItem:saved';
  }
  if (node.origin === 'tracked') {
    if (node.isSaved) return 'windowItem:tracked:saved';
    return 'windowItem:tracked:allowAdd';
  }
  return 'windowItem:tracked';
}

/**
 * Select an icon for the tree item.  `isCurrentWorkspace` should be true if the
 * record corresponds to one of the open workspace folders.
 */
export function getNodeIcon(node: WindowNode, isCurrentWorkspace: boolean, dataManager: DataManager): vscode.ThemeIcon {
  const added = (typeof node.isSaved === 'boolean') ? node.isSaved : dataManager.isSaved(node.stableId);
  if (isCurrentWorkspace) {
    return new vscode.ThemeIcon('repo', new vscode.ThemeColor('charts.blue'));
  }
  if (node.origin === 'tracked') {
    return new vscode.ThemeIcon('repo');
  }
  return added ? new vscode.ThemeIcon('database') : new vscode.ThemeIcon('repo', new vscode.ThemeColor('disabledForeground'));
}

/**
 * Compute relative age string (delegates to helper for consistency).
 */
export { toRelativeTime };

/**
 * Convert path/uri pair into a Uri object suitable for `openFolder`.
 */
export function toDirUri(recordPath?: string, recordUri?: string): vscode.Uri | undefined {
  if (recordUri) {
    try {
      return vscode.Uri.parse(recordUri);
    } catch {
      return undefined;
    }
  }
  if (!recordPath) {
    return undefined;
  }
  return vscode.Uri.file(recordPath);
}

/**
 * Returns true if the provided record path or uri matches one of the
 * workspace folders.
 */
export function isCurrentWorkspace(recordPath?: string, recordUri?: string): boolean {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    return false;
  }
  if (recordPath) {
    for (const folder of vscode.workspace.workspaceFolders) {
      if (folder.uri.fsPath === recordPath) {
        return true;
      }
    }
  }
  if (recordUri) {
    try {
      const uri = vscode.Uri.parse(recordUri);
      for (const folder of vscode.workspace.workspaceFolders) {
        if (folder.uri.fsPath === uri.fsPath) {
          return true;
        }
      }
    } catch {
      // ignore parse errors
    }
  }
  return false;
}
