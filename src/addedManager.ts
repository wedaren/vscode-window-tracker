import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { WindowNode } from './types';
import { DataManager } from './dataManager';

export function createAddedManager(dataManager: DataManager) {
    const addedSet = new Set<string>(dataManager.getAddedArray());

    function normalizeCandidate(addedId: string): WindowNode {
        let candidate = addedId;
        if (addedId.includes('::')) {
            candidate = addedId.split('::')[0];
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
                stableId: addedId,
                title: path.basename(p) || addedId,
                path: p,
                uri: u.toString(),
                pid: undefined,
                windowId: undefined,
                lastActive: Date.now(),
                source: 'added',
                status: 'idle',
                origin: 'added',
                dirUri: u,
                relativeActive: 'now',
            };
        } catch {
            return {
                type: 'window',
                stableId: addedId,
                title: addedId,
                path: undefined,
                uri: undefined,
                pid: undefined,
                windowId: undefined,
                lastActive: Date.now(),
                source: 'added',
                status: 'idle',
                origin: 'added',
                dirUri: undefined,
                relativeActive: 'now',
            };
        }
    }

    return {
        isAdded(stableId: string) {
            return addedSet.has(stableId);
        },
        async add(stableId: string) {
            addedSet.add(stableId);
            await dataManager.persistAddedArray([...addedSet]);
        },
        async remove(stableId: string) {
            if (addedSet.has(stableId)) {
                addedSet.delete(stableId);
                await dataManager.persistAddedArray([...addedSet]);
            }
        },
        getAll() {
            return [...addedSet];
        },
        buildAddedNodes(): WindowNode[] {
            return [...addedSet].map(normalizeCandidate);  
        },
    };
}
