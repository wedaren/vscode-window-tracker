import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Tracks the current workspace/window and emits periodic heartbeats to a
 * JSON file.  Designed to be used by `DataManager` or directly in tests.
 *
 * Historically this lived in its own file; it was pulled into DataManager
 * during a large refactor but the class remained logically independent.  The
 * documentation still references a standalone module, so we recreate that
 * arrangement to keep the codebase modular and make unit testing easier.
 */
export class TrackerService {
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
