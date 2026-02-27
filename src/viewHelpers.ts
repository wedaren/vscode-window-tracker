import * as path from 'path';
import * as vscode from 'vscode';
import { WindowNode } from './types';
import { buildDedupKeys } from './helpers';
import { DataManager } from './dataManager';

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
  // only the relative time is shown
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
export { toRelativeTime } from './helpers';

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
