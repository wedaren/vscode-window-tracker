# vscode-window-tracker

同时打开十余个 VS Code 窗口执行不同任务？用这个扩展快速定位、切换并管理所有工作区窗口。

**核心入口**：`cmd+j cmd+w`（macOS）打开 QuickPick，模糊搜索 + 键盘直接跳转目标窗口。

---

## 功能概览

### QuickPick 窗口切换（`cmd+j cmd+w`）

- **模糊搜索**：同时匹配项目名、路径、相对时间与变更文件数，十余窗口秒级定位
- **自动添加当前窗口**：若当前工作区尚未保存，列表顶部显示 `+ 添加当前窗口`，回车一键加入
- **当前窗口直接重命名**：选中当前窗口条目后回车，立即弹出重命名框，无需额外步骤
- **置顶按钮**：每个已保存项右侧显示 pin 按钮，点击即切换置顶状态，列表实时刷新
- **智能排序**：置顶 → 最近使用 → 使用频率 → 有展示名优先
- **丰富展示**：图标区分当前/置顶/已保存/普通，描述包含相对时间与未提交变更数，详情显示路径末尾两段

### 侧边栏 Tree View

- 展示所有当前/历史工作区快照，区分 `focused` / `idle` 状态
- 右键菜单：打开、编辑（展示名 + 颜色 + 置顶）、添加/移除保存、关闭窗口
- 悬浮提示（Tooltip）：完整元数据 + 最近 git 变更文件列表

### 已保存项目（saved.json）

- 持久化保存常用工作区，跨会话保留展示名、颜色标记、置顶状态、使用次数
- 文件位置：`~/.vscode-window-tracker/saved.json`，可直接编辑
- 命令：`Window Tracker: Open saved.json` 快速打开文件

---

## 快速上手

1. 打开侧边栏，找到 **Window Tracker** 视图（活动栏 or 视图菜单）
2. 按 `cmd+j cmd+w` 打开 QuickPick，输入关键字定位窗口，回车跳转
3. 对要固定的项目：点击条目右侧 pin 图标置顶，或通过树视图右键 → 编辑 配置展示名与颜色

---

## 命令

| 命令 | 说明 |
|---|---|
| `Window Tracker: Open QuickPick` | 打开窗口快速选择（`cmd+j cmd+w`） |
| `Window Tracker: Refresh` | 强制刷新视图 |
| `Window Tracker: Reveal` | 在新窗口中打开所选目录 |
| `Window Tracker: Add Project` | 添加文件夹到已保存列表 |
| `Window Tracker: Remove Project` | 从已保存列表移除 |
| `Window Tracker: Edit Project` | 编辑展示名、颜色、置顶状态 |
| `Window Tracker: Open saved.json` | 直接打开 saved.json 文件 |
| `Window Tracker: Open Project by ID` | 通过 stableId 跳转（可绑自定义快捷键） |

---

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `vscode-window-tracker.trackerDir` | `~/.vscode-window-tracker` | tracker 文件目录 |
| `vscode-window-tracker.heartbeatIntervalSeconds` | `5` | 心跳写入间隔（秒） |
| `vscode-window-tracker.trackerFileStaleMinutes` | `30` | tracker 文件过期阈值（分钟） |
| `vscode-window-tracker.trackerAutoCleanup` | `true` | 激活时自动清理过期文件 |
| `vscode-window-tracker.idleThresholdMinutes` | `30` | 超过多少分钟无活动视为 idle |

---

## saved.json 格式

```json
[
  {
    "id": "/Users/name/workspace/demo-app",
    "displayName": "演示项目",
    "color": "blue",
    "pinned": true
  },
  {
    "id": "/Users/name/workspace/admin-console",
    "displayName": "后台",
    "color": "orange"
  }
]
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 项目路径或可解析 URI（必填） |
| `displayName` | string | 展示名，配置后显示为"展示名（原名）" |
| `color` | string | 图标颜色：`blue` `green` `yellow` `orange` `red` `pink` `purple` `cyan` `gray` |
| `pinned` | boolean | 是否置顶（排序最优先） |
| `openCount` | number | 通过 QuickPick 打开的累计次数（用于频率排序，自动维护） |
| `keybinding` | string | 为该项绑定的自定义快捷键（配合 `openByStableId` 命令） |
| `lastActive` | number | 最近活跃时间戳（毫秒），自动维护 |

---

## 隐私与安全

扩展仅在本地保存会话快照（JSON 格式），不向网络发送或同步任何数据。

---

## 故障排查

- **未显示任何窗口**：使用 `Window Tracker: Refresh` 强制刷新
- **列表数据不一致**：检查 `~/.vscode-window-tracker` 目录是否存在且可读
- **重命名不生效**：确认通过 QuickPick 选中当前窗口条目后按回车，而非点击其他按钮
- **清理旧记录**：调整 `trackerFileStaleMinutes` 配置，或直接删除 `~/.vscode-window-tracker` 下的旧文件
