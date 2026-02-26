import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { WindowNode } from './types';
import { DataManager } from './dataManager';

export class SavedService {
    private dataManager: DataManager;
    private savedSet: Set<string>;

    constructor(dataManager: DataManager) {
        this.dataManager = dataManager;
        this.savedSet = new Set<string>(dataManager.getSavedArray());
    }

    isSaved(stableId: string) {
        return this.savedSet.has(stableId);
    }

    async save(stableId: string) {
        this.savedSet.add(stableId);
        await this.dataManager.persistSavedArray([...this.savedSet]);
    }

    async remove(stableId: string) {
            if (this.savedSet.has(stableId)) {
            this.savedSet.delete(stableId);
            await this.dataManager.persistSavedArray([...this.savedSet]);
        }
    }

    getAll() {
        return [...this.savedSet];
    }

    buildSavedNodes(trackedById?: Map<string, import('./types').WindowNode>): WindowNode[] {
        return [...this.savedSet].map((savedId) => this.normalizeCandidate(savedId, trackedById?.get(savedId)?.lastActive));
    }

    private normalizeCandidate(savedId: string, lastActiveOverride?: number): WindowNode {
        let candidate = savedId;
        if (savedId.includes('::')) {
            candidate = savedId.split('::')[0];
        }
        if (candidate.startsWith('~')) {
            candidate = candidate.replace(/^~(?=$|\/|\\)/, os.homedir());
        }
        try {
            let u: vscode.Uri;
            if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
                u = vscode.Uri.parse(candidate);
            } else {
                u = vscode.Uri.file(candidate);
            }
            const p = u.fsPath || candidate;
            return {
                type: 'window',
                stableId: savedId,
                title: path.basename(p) || savedId,
                path: p,
                uri: u.toString(),
                pid: undefined,
                windowId: undefined,
                lastActive: typeof lastActiveOverride === 'number' ? lastActiveOverride : Date.now(),
                source: 'saved',
                status: 'idle',
                origin: 'saved',
                dirUri: u,
                relativeActive: 'now',
            };
        } catch {
            return {
                type: 'window',
                stableId: savedId,
                title: savedId,
                path: undefined,
                uri: undefined,
                pid: undefined,
                windowId: undefined,
                lastActive: typeof lastActiveOverride === 'number' ? lastActiveOverride : Date.now(),
                source: 'saved',
                status: 'idle',
                origin: 'saved',
                dirUri: undefined,
                relativeActive: 'now',
            };
        }
    }
}

export default SavedService;
