# vscode-window-tracker — 完整需求文档

## 概述

该扩展用于收集、显示并管理用户在 VS Code 中的窗口/工作区信息，帮助用户跟踪最近活动的窗口、保存常用项目、快速在窗口间切换与恢复工作环境。

## 目标用户

- 经常在多个工作区/项目之间切换的开发者
- 需要持久化记录和快速恢复工作上下文的用户

## 主要目标

- 自动追踪并记录 VS Code 窗口的活跃信息（心跳/lastActive）。
- 显示最近活动的窗口列表，按活跃时间排序，并支持在视图中进行快速操作（Reveal、Add/Remove Saved）。
- 提供“已保存”集合，允许用户把常用窗口固定到顶部并持久化。
- 将跟踪数据以 JSON 文件保存在用户可配置的目录下，支持自动清理过期文件。

## 功能需求

1. 实时跟踪（TrackerService）
	- 周期性写入心跳文件到 tracker 目录（默认 5s，可配置）。
	- 心跳数据包含：title、path、uri、pid、lastActive、status、source 等字段。

2. 读取与合并（DataManager）
	- 从 tracker 目录读取多个窗口记录并与当前 workspace 合并。
	- 去重策略：基于 generate 的 dedup keys（uri/path/title 等）合并，保留最新的 lastActive。

3. 已保存管理（SavedService）
	- 支持 `save(path)`、`remove(path)`、`isSaved(path)`、`getAllSaved()`。
	- 保存数组同时持久化到 `globalState` 与可编辑的 `saved.json`（存放于 trackerDir）。
	- 当已保存项同时被追踪且处于活跃状态时，自动刷新 `saved.json` 的 `lastActive`。

4. 树视图（TreeProvider）与 UI
	- 在 Activity Bar 中提供 Window Tracker 视图。
	- 每一项显示标题（优先 basename）、相对活跃时间（中文“xx 前”）、tooltip（包含详细元数据）。
	- 支持上下文菜单：Refresh、打开项目（open folder）、Add Project、Remove Project、Close Window、Open saved.json。
	- 图标选择：当前 workspace 标示为突出图标，已保存项使用数据库图标。

5. 配置项
	- `vscode-window-tracker.trackerDir`：tracker 文件目录（支持 `~` 展开，且限制在用户主目录内）。
	- `vscode-window-tracker.idleThresholdMinutes`：判定 idle 的阈值（分钟，当前未在代码中使用）。
	- `vscode-window-tracker.heartbeatIntervalSeconds`：心跳写入间隔（秒）。
	- `vscode-window-tracker.trackerFileStaleMinutes`：忽略过期 tracker 文件的阈值（分钟）。
	- `vscode-window-tracker.trackerAutoCleanup`：激活时自动清理过期文件（布尔）。

6. 自动清理
	- 激活扩展时（activation），若 `trackerAutoCleanup` 为 true，扫描 trackerDir 删除超过 `trackerFileStaleMinutes` 的文件。

7. 边界与错误处理
	- 任何 I/O 都应有容错（读取失败返回空列表，写入失败记录日志且不阻塞主流程）。
	- trackerDir 不合法或不在用户主目录下时回退到默认目录 `~/.vscode-window-tracker`。

## 数据模型

- WindowRecord
  - title: string
  - path?: string
  - uri?: string
  - pid?: number
  - lastActive?: number (ms)
  - source: 'vscode' | 'tracker' | ...
  - status?: string

- WindowNode (UI 封装)
  - 在 WindowRecord 基础上增加：stableId、origin（tracked/saved）、dirUri、relativeActive、isSaved 等。

## 文件与格式

- Tracker 文件：每个窗口对应一个 JSON 文件（可由其他进程/脚本生成），数组或单对象均支持。文件名可包含窗口 id 或 PID。
- saved.json：用户可编辑的文件（优先读取），内容是已保存项数组（含 `id` 与可选 `lastActive`），并同步到 `globalState` 作为镜像。

## 命令清单（需与 package.json 保持一致）

- `vscode-window-tracker.refresh` — 刷新视图
- `vscode-window-tracker.reveal` — 打开项目（open folder）
- `vscode-window-tracker.addProject` — 添加到已保存
- `vscode-window-tracker.removeProject` — 从已保存移除
- `vscode-window-tracker.openSavedJson` — 打开 saved.json
- `vscode-window-tracker.closeWindow` — 关闭当前窗口

## 非功能需求

- 性能：心跳写入应是轻量异步操作，读取 tracker 文件时应使用并发限流，避免阻塞激活流程。
- 可移植性：支持 macOS、Linux、Windows；路径处理需兼容 fsPath 与 URI。
- 安全：不在 telemetry 或日志中写入敏感路径内容（如含凭证的路径）；tooltip 标记为不受信任（isTrusted=false）。
- 本地化：UI 文本应便于未来 i18n，但首版可先提供中文/英文注释与文案。

## 可测试性

- 单元测试覆盖：DataManager（去重/合并/normalize）、SavedService（持久化逻辑）、TrackerService（心跳 start/stop 与文件写入模拟）、helpers（toRelativeTime、buildDedupKeys）。
- 集成测试：在 CI 中运行 headless 的命令测试（使用 @vscode/test-electron），模拟 tracker 文件并验证视图节点生成。

## 验收标准

- 在本地激活扩展时，能够在 activity bar 中看到按活跃时间排序的窗口列表。
- 能够通过 `Add Project` 把条目加入已保存，并能在 `saved.json` 和 `globalState` 中持久化。
- 修改配置 `heartbeatIntervalSeconds` 会改变心跳文件生成频率（可在测试目录观察到文件更新）。

## 回归与兼容性

- 保持 `saved.json` 的向后兼容：若旧格式存在（例如对象而非数组），扩展在读取时应兼容并在保存时迁移至新数组格式。

## 可选 / 未来拓展

- 支持按标签分组保存窗口（projects groups）。
- 增加导入/导出功能（JSON 导入导出 saved 列表）。
- 与 Remote / WSL 场景更深集成，支持跨机器同步（注意安全与隐私）。

## 开放问题

- 是否需要对 tracker 文件的命名或目录结构定义更强约束？
- 是否采集并上报匿名使用统计（需征得许可并遵守隐私）？

---

文档结束。如需我根据此需求生成任务列表、实现初始 PR 或者创建测试用例，我可以继续执行下一步工作。
