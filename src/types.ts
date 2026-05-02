import * as vscode from 'vscode';
/**
 * @docs WindowRecord
 * 单个窗口/工作区的心跳记录，写入 tracker JSON 文件以供外部进程读取。
 *
 * 字段说明：
 * - `title`: 显示名称或当前活跃编辑器文件名。
 * - `path`: 工作区文件夹的本地路径（如果有）。
 * - `uri`: 工作区的 URI 字符串形式（如果有）。
 * - `pid`: 生成该记录的进程 ID。
 * - `windowId`: 可选的窗口标识符（平台/守护进程提供）。
 * - `lastActive`: 最近活动的时间戳（毫秒）。
 * - `source`: 记录来源（如 `vscode-extension`、`vscode`、`saved`）。
 * - `status`: 窗口状态字符串（例如 `focused`、`visible`、`idle`）。
 */

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

/**
 * @docs SavedColor
 * 已保存项目支持的基础颜色枚举。
 */
export const SAVED_COLORS = [
  'blue',
  'green',
  'yellow',
  'orange',
  'red',
  'pink',
  'purple',
  'cyan',
  'gray',
] as const;

export type SavedColor = (typeof SAVED_COLORS)[number];

/**
 * @docs SavedItem
 * 表示保存列表中的条目，兼容旧格式（string id）和新格式（object）。
 *
 * - `keybinding`: 用户在 saved.json 中自定义的快捷键字符串（例如 `"cmd+j cmd+k"`）。
 * - `pinned`: 若为 true，则在 QuickPick 与树视图中置顶显示。
 * - `openCount`: 通过 QuickPick 打开该窗口的累计次数，用于使用频率排序。
 */
export type SavedItem = {
  id: string;
  lastActive?: number;
  keybinding?: string;
  displayName?: string;
  color?: SavedColor;
  pinned?: boolean;
  openCount?: number;
};

/**
 * @docs WindowNode
 * 在 UI 中使用的节点类型，基于 `WindowRecord` 并添加树视图/渲染相关元数据。
 *
 * - `stableId`: 用于去重与持久化的稳定标识符。
 * - `origin`: 表示该节点是来自跟踪（`tracked`）还是用户保存（`saved`）。
 * - `lastFileChangeMs`: 工作区最近文件变更时间戳（毫秒），来自 git 状态或文件 mtime。
 * - `recentChangedFiles`: 最近有变更的文件相对路径列表（staged + unstaged）。
 */
export interface WindowNode extends WindowRecord {
  type: 'window';
  stableId: string;
  origin: 'tracked' | 'saved';
  dirUri?: vscode.Uri;
  relativeActive: string;
  isSaved?: boolean;
  /** 用户在 saved.json 为此项设置的快捷键字符串，例如 "cmd+j cmd+k" */
  keybinding?: string;
  displayName?: string;
  color?: SavedColor;
  savedItemId?: string;
  /** 工作区最近文件变更时间戳（毫秒），取 lastCommit 与有变更文件 mtime 的最大值 */
  lastFileChangeMs?: number;
  /** staged + unstaged 有变更的文件相对路径列表 */
  recentChangedFiles?: string[];
  /** 若为 true，则在 QuickPick 与树视图中置顶显示（独立于 isSaved） */
  pinned?: boolean;
  /** 通过 QuickPick 打开该窗口的累计次数，用于使用频率排序 */
  openCount?: number;
}
