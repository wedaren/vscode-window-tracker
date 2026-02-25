# vscode-window-tracker

用于可视化管理 VS Code 窗口/工作区快照的 TreeView 扩展。

## 已实现能力（MVP）

- TreeView 视图：`Window Tracker`（view id: `vscode-window-tracker.windowsView`）
- 状态模型：`focused` / `visible` / `idle`（当前代码未实现 `pinned` 功能）
- 视觉映射（实现要点）：
	- `focused`：以强调色显示（实现中使用主题图标/高亮）
	- `visible`：中性图标
	- `idle`：次要/空心图标（如 `circle-large-outline`）
- 右侧描述显示短路径与相对时间：`now / 5m / 2h / 1d`（实现为 `description` 字段，短路径 + 相对时间）
- Tooltip 展示 metadata：`title`、`path`、`pid`、`lastActive`、`source`、`status`（实现为 `MarkdownString`）
- 已实现的命令（扩展实际注册）：
	- `vscode-window-tracker.refresh` — 强制刷新视图
	- `vscode-window-tracker.reveal` — 在新窗口中打开对应目录（内部使用 `vscode.openFolder`）
	- `vscode-window-tracker.addProject` — 通过选择文件夹或手动添加到“已添加项目”列表
	- `vscode-window-tracker.removeProject` — 从“已添加项目”中移除
- 注意：`copyPath` / `pin` / `switch` / `new folder` 等在 `package.json` 中可能有贡献项或初始设计，但当前源码未注册或实现这些命令/功能。

- 数据来源与去重：
	- 可配置优先使用 daemon 文件（`vscode-window-tracker.preferDaemon`, `vscode-window-tracker.daemonFile`）。
	- 回退读取 tracker 目录（默认 `~/.vscode-window-tracker`）下的 JSON 文件，并合并当前 workspace 快照。
	- 去重键由 `DataManager.buildDedupKeys` 生成，优先级为 `uri+windowId` -> `uri+pid` -> `title`，`dedupe` 保留最近活动记录。

- 更新与持久化：
	- 扩展在激活时会写入当前会话的 tracker 文件（原子写入），并以配置 `vscode-window-tracker.heartbeatIntervalSeconds`（默认 5s）进行心跳刷新。
	- 激活时可清理过期的 tracker 文件（`vscode-window-tracker.trackerAutoCleanup` 与 `trackerFileStaleMinutes` 配置）。

## 运行与调试

1. 安装依赖

```bash
npm install
```

2. 编译

```bash
npm run compile
```

3. 启动扩展调试

- 在 VS Code 中按 `F5` 打开 Extension Development Host
- 在侧边栏中查看 `Window Tracker` 视图

## 说明

- `Reveal`（在新窗口打开）使用：

```ts
await vscode.commands.executeCommand('vscode.openFolder', dirUri, true);
```

- 如果你想让我把 README 中的“未实现”命令（如 `copyPath`）补充为真实实现，我可以继续实现并注册相应命令。
