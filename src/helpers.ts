import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WindowRecord } from './dataManager';
import { WindowNode } from './types';

/**
 * Generate a set of deduplication keys for a record.  Two records that share
 * any one of these keys are considered potentially referring to the same
 * logical workspace window.
 *
 * The keys are ordered by preference and are used by the internal `dedupe`
 * algorithm in `DataManager`.
 *
 * @param record - raw record obtained from tracker/daemon
 * @returns array of string keys (may contain duplicates)
 */
export function buildDedupKeys(record: WindowRecord): string[] {
  const uriOrPath = record.uri || record.path || 'unknown';
  const windowId = record.windowId ?? 'none';
  const pid = record.pid ?? 'none';
  const title = (record.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return [`${uriOrPath}::${windowId}`, `${uriOrPath}::${pid}`, `title::${title}`];
}

/**
 * Turn a UNIX timestamp into a human‑readable relative time string.  The
 * returned value describes how long ago the timestamp was, using the same
 * conventions as the tree view ("now", "5m", "12h", "3d").
 *
 * @param timestamp - milliseconds since epoch to compare against
 * @param now - reference time; defaults to Date.now() which makes the
 *   function easier to test
 */
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

/**
 * Convert a saved‑id string (which may be a URI, a filesystem path, or an
 * opaque identifier) into a `WindowNode` suitable for display.  This helper is
 * primarily used by the old `SavedService` logic that now lives in
 * `DataManager`.
 *
 * @param savedId - stable identifier of the saved window
 * @param lastActiveOverride - optional timestamp that should override the
 *   node's computed `lastActive` value
 */
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
