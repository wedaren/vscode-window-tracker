# Change Log

All notable changes to the "vscode-window-tracker" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.0.26]

### Added
- **Views Navigator 视图导航系统** — TreeView + QuickPick 双入口
  - TreeView 侧边栏 (`vscode-window-tracker.viewsNavigator`)：浏览、管理所有内置和扩展视图
  - QuickPick 快速跳转 (`Cmd+J Cmd+V`)：模糊搜索，一键聚焦到任意视图
  - **Pin 置顶**：TreeView 和 QuickPick 共享 `globalState` 状态，置顶项优先排在最前
  - **Hide 隐藏**：隐藏项在 QuickPick 中不显示；TreeView title bar 可切换过滤模式查看已隐藏项
  - **Note 备注**：为视图添加自定义备注，备注内容参与 QuickPick 搜索过滤
  - **MRU 最近使用**：自动记录视图访问时间戳，显示相对时间（如"2分钟前"），排在置顶之后
  - **重名处理**：同名视图在 description 中显示完整 viewId 和扩展名
  - **扩展视图扫描**：遍历 `~/.vscode/extensions/*/package.json` 自动发现所有扩展贡献的视图
  - 保留 `workbench.action.openView` 作为原生 fallback

## [0.0.21]

### Added
- **QuickPick 全面重设计**（`cmd+j cmd+w`）
  - 当前窗口不在已保存列表时，顶部自动出现"添加当前窗口"快捷入口
  - 选中当前窗口回车 → 直接弹出重命名框，无需额外步骤
  - 每个已保存项右侧新增置顶 (pin) 按钮，点击实时切换，列表立即刷新
  - 同时开启 `matchOnDescription` + `matchOnDetail`，支持按时间、路径、变更数模糊过滤
  - 详情行显示路径末尾两段，简洁定位
- **置顶（pinned）字段**：`SavedItem` / `WindowNode` 新增 `pinned`，独立于 `isSaved`
- **使用频率（openCount）字段**：通过 QuickPick 打开窗口时自动 +1，用于排序
- **新排序策略**：置顶 → 最近使用 → 使用频率 → 有展示名优先
- `treeProvider.editProjectByNode` 新增第三步：可在编辑流程中直接设置置顶状态
- `DataManager` 新增 `togglePinned` / `togglePinnedTo` / `incrementOpenCount` 方法

### Removed
- 移除 `cmd+j cmd+[`（切换上一窗口）和 `cmd+j cmd+]`（切换下一窗口）快捷键
- 移除 `openPrevWindow` / `openNextWindow` 命令注册

### Fixed
- QuickPick 操作（重命名、置顶）现与 TreeView 共用同一 `DataManager` 实例，避免因多实例内存不同步导致操作不生效

## [0.0.20]

- 保留 `cmd+j cmd+w` 打开 QuickPick

## [0.0.1]

- Initial release
