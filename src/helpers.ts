import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WindowRecord } from './dataManager';
import { WindowNode } from './types';

/**
 * 生成一组去重键。两个记录只要共享其中之一就视为可能是同一窗口。
 *
 * 键按优先级排序（uri+windowId、uri+pid、标题），由 `DataManager`
 * 的 `dedupe` 算法使用。
 *
 * 原理：优先使用 URI/路径，因为它们最稳定；其次 pid/windowId；最后标题
 * 用于补充无法从 URI 获取的情况。
 *
 * @param record - 来自 tracker/daemon 的原始记录
 * @returns 字符串键数组（可能重复）
 */
export function buildDedupKeys(record: WindowRecord): string[] {
  const uriOrPath = record.uri || record.path || 'unknown';
  const windowId = record.windowId ?? 'none';
  const pid = record.pid ?? 'none';
  const title = (record.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return [`${uriOrPath}::${windowId}`, `${uriOrPath}::${pid}`, `title::${title}`];
}

/**
 * 将 UNIX 时间戳格式化为树视图使用的相对时间字符串（"now"、"5m"、
 * "12h"、"3d" 等）。
 *
 * 原理：先计算当前时间与目标时间的差值，然后按分钟/小时/天级别
 * 分段返回。
 *
 * @param timestamp - 待比较的毫秒级时间戳
 * @param now - 参考时间，默认使用 Date.now() 以便测试可控
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
 * 将保存的 id 字符串转换为可显示的 `WindowNode`。
 *
 * 输入可能是 URI、文件路径或者任意字符串。函数会尝试解析成
 * vscode.Uri，如果失败则视为普通文本并填充 title。
 *
 * 原理：
 * 1. 去除类似 "uri::pid" 的后缀，只保留 uri 部分；
 * 2. 展开 ~; 3. 使用 `vscode.Uri.parse` 或 `Uri.file` 创建 Uri；
 * 4. 构建包含 stableId、path、uri、lastActive 等字段的节点对象。
 *
 * 此方法用于 `SavedService` / `DataManager` 的节点生成逻辑。
 *
 * @param savedId - 保存的稳定标识符
 * @param lastActiveOverride - 可选的 lastActive 时间覆盖
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
