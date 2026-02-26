import * as path from 'path';
import * as vscode from 'vscode';
import { DataManager, WindowRecord } from './dataManager';
import { WindowNode } from './types';

export function normalizeTrackedNodes(records: WindowRecord[], dataManager: DataManager): WindowNode[] {
    const now = Date.now();
    const enriched: WindowNode[] = records.map((record, index) => {
        const stableId = (dataManager.buildDedupKeys(record) || [])[0] || `${record.path || record.title || 'window'}-${index}`;
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

function toRelativeTime(timestamp: number, now: number): string {
    const diffMs = now - timestamp;
    if (diffMs < 60_000) return 'now';
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
}
