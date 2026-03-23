# vscode-window-tracker

一个在 VS Code 侧边栏以 Tree View 形式展示并管理本地 VS Code 窗口/工作区快照的扩展。

**目标用户**：希望可视化、快速定位并管理本地已打开或历史工作区窗口的开发者。

**核心能力（用户视角）**

- 在侧边栏展示 `Window Tracker` 视图，用于列出当前/历史会话的窗口快照。
- 可区分“聚焦（focused）”和“可见（visible）”状态：聚焦项以强调色显示，其他项使用中性图标。
- 列表项右侧显示短路径与相对时间（如 now / 5m / 2h / 1d），Tooltip 提供完整元数据（标题、路径、进程 ID、最近激活时间、来源、状态等）。
- 支持常用命令：刷新视图、在新窗口中打开所选目录、将文件夹加入“已添加项目”、从“已添加项目”中移除。

**快速上手**

1. 打开侧边栏，找到“Window Tracker”视图（可在活动栏或“视图”菜单中显示）。
2. 列表会显示当前会话及从本机 tracker 存储合并的历史快照。
3. 右键/点击可调出上下文菜单或使用命令面板调用相关命令（见下文）。

**主要交互与命令**

- 刷新视图：命令面板输入 `Window Tracker: Refresh`（命令 id: `vscode-window-tracker.refresh`）。
- 在新窗口中打开目录：选择某项，使用 `Window Tracker: Reveal`（命令 id: `vscode-window-tracker.reveal`），将在新 VS Code 窗口中打开对应目录。
- 添加已管理项目：使用 `Window Tracker: Add Project`（命令 id: `vscode-window-tracker.addProject`），可通过选择文件夹或手动输入路径将项目加入“已添加项目”列表，便于固定显示与快速访问。
- 移除已添加项目：使用 `Window Tracker: Remove Project`（命令 id: `vscode-window-tracker.removeProject`）。

在命令面板里输入 `Window Tracker` 可快速查看和执行以上命令。

**视图与视觉提示**

- 聚焦（focused）：以主题强调色或高亮图标显示，表示当前处于前台的 VS Code 窗口/工作区。
- 可见（visible）：使用中性图标，表示该窗口在系统层面仍可见但未被聚焦。
- 列表项描述：短路径 + 相对时间，用于快速判断最近活动和位置；悬浮提示（Tooltip）显示详细信息供审阅。

**数据存储与行为（对用户可见的重要点）**

- 本扩展在本地目录下维护会话快照（默认位置：`~/.vscode-window-tracker`），每次激活会写入当前会话的 tracker 文件。
- 为保证展示合理性，扩展会合并当前会话与该目录下的历史 JSON 文件，并对重复项进行去重（按窗口标识 / 进程标识 / 标题等优先信息保留最近活动记录）。
- 扩展会定期写入心跳以更新时间戳（使用 `vscode-window-tracker.heartbeatIntervalSeconds` 配置，默认 5 秒），并可在激活时清理过期的 tracker 文件（可配置自动清理策略）。

**配置（可在扩展设置中查看与调整）**

- `vscode-window-tracker.heartbeatIntervalSeconds`：心跳写入间隔（秒），用于更新最近活动时间；默认 5 秒。
- `vscode-window-tracker.trackerAutoCleanup`：是否在激活时自动清理过期 tracker 文件（可在设置中启用/禁用）。
- `vscode-window-tracker.trackerFileStaleMinutes`：判定 tracker 文件为过期的时间阈值（以分钟计）。

（备注：更多配置项可通过 VS Code 设置界面搜索 “Window Tracker” 查看）

**常见场景示例**

- 快速切换到历史工作区：在 `Window Tracker` 列表中找到目标项，使用 `Reveal` 在新窗口中打开该目录。
- 固定常用项目：用 `Add Project` 将某些目录加入“已添加项目”，它们会在视图中优先显示，便于长期管理。
- 点击任意项目：会弹出 Quick Pick，可直接设置展示名与基础颜色；展示名会以“展示名（原名）”形式显示。

**saved.json 自定义示例**

```json
[
	{
		"id": "/Users/name/workspace/demo-app",
		"displayName": "演示项目",
		"color": "blue"
	},
	{
		"id": "/Users/name/workspace/admin-console",
		"displayName": "后台",
		"color": "orange"
	}
]
```

- `id`：项目路径或可解析 URI。
- `displayName`：可选，配置后显示为“展示名（原名）”。
- `color`：可选，支持 `blue`、`green`、`yellow`、`orange`、`red`、`pink`、`purple`、`cyan`、`gray`，用于节点图标标识。

**故障排查**

- 未显示任何窗口：尝试使用 `Window Tracker: Refresh` 强制刷新。
- 列表数据不一致或缺失：检查主机上 `~/.vscode-window-tracker` 目录是否存在与可读；确保 VS Code 有权限写入你的主目录。
- 清理旧记录：可通过设置关闭/调整自动清理策略，或直接删除 `~/.vscode-window-tracker` 下的旧文件来手动清理。

**隐私与安全**

- 扩展仅在本地保存会话快照（JSON 格式），不向网络发送或同步这些数据。请妥善保管你的主目录权限；如需更严格控制，请在设置中禁用自动写入或定期清理数据目录。

**更多帮助**

- 如果需要功能建议或遇到问题，请在扩展页面中查看支持信息或打开 issue（扩展仓库/市场页提供的渠道）。

---

更新于：2026-02-27
