import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WindowRecord, WindowNode } from './types';

// 生成去重键数组，用于判断两个记录是否代表同一窗口。
export function buildDedupKeys(record: WindowRecord): string[] {
  const uriOrPath = record.uri || record.path || 'unknown';
  const windowId = record.windowId ?? 'none';
  const pid = record.pid ?? 'none';
  const title = (record.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return [`${uriOrPath}::${windowId}`, `${uriOrPath}::${pid}`, `title::${title}`];
}

// 将时间戳转为相对时间字符串（例如 "5m"、"3d"）。
export function toRelativeTime(timestamp: number, now = Date.now()): string {
  const diffMs = now - timestamp;
  if (diffMs < 60_000) return 'now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// 将保存 ID 解析为 WindowNode，用于生成树视图项。
export function normalizeSavedCandidate(savedId: string, lastActiveOverride?: number): WindowNode {
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
