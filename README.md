# multiWindowManager

用于可视化管理 VS Code 窗口/项目状态的 TreeView 扩展。

## 已实现能力（MVP）

- TreeView 视图：`Window / Project Manager`
- 状态模型：`focused` / `visible` / `idle` + `pinned`
- 视觉映射：
	- `focused`：`eye`（蓝色强调）
	- `visible`：`eye`
	- `idle`：弱化图标（`circle-large-outline`）
	- `pinned`：`pin`
- 右侧描述显示短路径与相对时间：`now / 5m / 2h / 1d`
- Tooltip 展示 metadata：`title`、`path`、`pid`、`lastActive`、`source`、`status`
- 操作命令：`Switch`、`Open New Window`、`New Folder`、`Reveal`、`Copy Path`、`Pin / Unpin`
- 数据源：
	- 优先读取 `~/.vscode-window-tracker/*.json`
	- 同时注入当前 workspace 记录
	- 去重规则：`uri+windowId` -> `uri+pid` -> `title`（模糊）
- 更新策略：5s 心跳刷新 + 差异哈希，避免不必要重绘
- 大量窗口（>200）自动按状态分组折叠

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
- 在资源管理器中查看 `Window / Project Manager`

## 说明

- `Open New Window` 使用 VS Code 命令：

```ts
await vscode.commands.executeCommand('vscode.openFolder', dirUri, { forceNewWindow: true });
```

- `Switch` 使用同一命令并复用当前窗口（`forceNewWindow: false`）。
- 若无辅助权限或无 tracker 数据，仍可通过当前 workspace 记录正常使用基础能力。
