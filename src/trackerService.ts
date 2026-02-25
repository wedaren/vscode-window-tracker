import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

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
    private readonly fsImpl: typeof fs;

    constructor(context: vscode.ExtensionContext, options?: { fs?: typeof fs }) {
        this.context = context;
        this.fsImpl = options?.fs ?? fs;
        const cfg = vscode.workspace.getConfiguration('vscode-window-tracker');
        const rawTrackerDir = cfg.get<string>('trackerDir', '~/.vscode-window-tracker')!;
        this.trackerDir = rawTrackerDir.replace(/^~(?=$|\/|\\)/, os.homedir());
        this.heartbeatSeconds = cfg.get<number>('heartbeatIntervalSeconds', 5) ?? 5;
        this.staleMinutes = cfg.get<number>('trackerFileStaleMinutes', 30) ?? 30;
        this.autoCleanup = cfg.get<boolean>('trackerAutoCleanup', true) ?? true;

        this.trackerFilePath = this.context.globalState.get<string>('vscode-window-tracker.trackerFile');

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
        if (!this.trackerFilePath) {
            const fname = `vscode-${process.pid}-${Date.now()}.json`;
            this.trackerFilePath = path.join(this.trackerDir, fname);
            await this.context.globalState.update('vscode-window-tracker.trackerFile', this.trackerFilePath);
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const folderPath = workspaceFolder?.uri.fsPath;
        const rec = {
            title: vscode.window.activeTextEditor?.document.fileName ? path.basename(vscode.window.activeTextEditor.document.fileName) : 'Current Workspace',
            path: folderPath,
            uri: workspaceFolder?.uri.toString(),
            pid: process.pid,
            lastActive: Date.now(),
            source: 'vscode-extension',
            status: vscode.window.state.focused ? 'focused' : 'visible',
        };

        try {
            const tmp = `${this.trackerFilePath}.tmp`;
            await this.fsImpl.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
            await this.fsImpl.rename(tmp, this.trackerFilePath);
        } catch (e) {
            // Keep parity with previous behavior: log but don't throw
            // eslint-disable-next-line no-console
            console.error('Failed to write tracker file', e);
        }
    }

    async removeNow(): Promise<void> {
        if (!this.trackerFilePath) return;
        try {
            await this.fsImpl.unlink(this.trackerFilePath);
        } catch {
            // ignore
        }
        this.trackerFilePath = undefined;
        await this.context.globalState.update('vscode-window-tracker.trackerFile', undefined);
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

export default TrackerService;
