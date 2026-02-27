````markdown
# TrackerService 文档

> **当前实现**：`TrackerService` 现在再次作为独立模块存在于 `src/trackerService.ts`，
> 以便于单元测试和代码组织。
> 
> 历史记录：该类在早期版本中曾经单独存在，随后在 2026 年的重构中
> 暂时合并到 `DataManager` 中；本次重构将其拆分回单独文件，并且
> 仍然保留通过 `DataManager` 访问的便利方法。

## 概述

轨迹写入与生命周期管理的原理（原 `TrackerService` 提供的功能）包括：原子写入、周期心跳、启动时清理过期文件、以及在扩展停用或进程退出时移除当前会话文件。
该服务的目标是将与文件系统、计时器和进程信号相关的副作用从 `extension.ts` 中剥离，提升可测试性与可维护性。

## 公共 API

- `new TrackerService(context: vscode.ExtensionContext)`：构造函数，读取配置并（如果存在）尝试从 `globalState` 恢复先前记录的 tracker 文件路径。
- `start(): void`：启动服务（执行一次启动清理、立即写入、注册心跳定时器和 VS Code 事件监听、注册进程信号处理）。
- `stop(): void`：停止服务（停止定时器、移除事件监听、取消信号处理、并尝试删除当前 tracker 文件）。

这些方法是幂等的：重复调用 `start()` 会再次启动心跳（注意不要多次创建实例），`stop()` 会清理对应的资源。

## 配置与行为

- `vscode-window-tracker.trackerDir`：tracker 存放目录（支持 `~`，默认 `~/.vscode-window-tracker`）。
- `vscode-window-tracker.heartbeatIntervalSeconds`：心跳间隔，单位秒，默认 `5`。
- `vscode-window-tracker.trackerAutoCleanup`：是否在激活时清理过期文件，默认 `true`。
- `vscode-window-tracker.trackerFileStaleMinutes`：多久未活动视为过期（分钟），默认 `30`。

实现细节：

- 写入采用“原子写入”策略：先写入临时文件 `<file>.tmp`，然后 `rename` 覆盖目标文件；这样读者不会看到部分写入的数据。
- 启动清理会遍历 `trackerDir` 下的 `.json` 文件，解析 `lastActive` 字段并删除超过阈值的文件，解析错误或不可读文件会被忽略以保证鲁棒性。
- 在 `start()` 中注册的进程事件：`exit`、`SIGINT`、`SIGTERM`、`uncaughtException`，以便在进程退出或异常时移除 tracker 文件（防止遗留）。

持久化与清理行为（实现细节补充）：

- 写入成功后，服务会把所使用的 tracker 文件路径写入 `context.globalState`（键名：`vscode-window-tracker.trackerFile`），以便后续运行或测试期间能恢复并正确清理该文件。
- 当调用 `removeNow()`（或 `stop()` 间接触发）删除当前会话文件时，如果内存中没有记录 `trackerFilePath`，服务会尝试从 `context.globalState` 中读取该路径并删除对应文件，随后把该 globalState 条目清空。这使得跨会话或测试中由不同进程/实例生成的文件也能被正确清理。

## 在 `extension.ts` 中的使用示例

```ts
import { TrackerService } from './trackerService';

export function activate(context: vscode.ExtensionContext) {
  const tracker = new TrackerService(context);
  tracker.start();
  context.subscriptions.push({ dispose: () => tracker.stop() });
}
```

## 测试建议

- 将 `TrackerService` 的文件 I/O 隐式依赖抽象（当前实现直接使用 `fs/promises`）。在单元测试中，可以：
  - 使用 `mock-fs` 或 sinon stub 对 `fs` 方法（`writeFile`、`rename`、`unlink`、`readFile`、`readdir`）进行模拟；
  - 模拟 `vscode.workspace.getConfiguration` 返回自定义配置，以测试不同配置下的行为；
  - 使用 `sinon.useFakeTimers()` 控制心跳和时间相关逻辑；
  - 验证 `start()` 后会产生 `.json` 文件并定期更新 `lastActive` 字段；验证 `stop()` 会删除对应文件并清理定时器事件。

## 可改进点

- 将 `fs` 操作改为可注入（工厂/依赖注入），以便测试时完全替换 I/O 实现；
- 将错误上报从 `console.error` 改为通过 `vscode.window.showErrorMessage` 或 telemetry（按需）；
- 支持在同一进程内多实例或手动指定 tracker 文件名的场景（当前以 PID+时间戳自动生成名）。

## 维护者提示

- `trackerService` 的行为与用户配置紧密相关，请在修改默认配置键时在 `package.json` 中同步更新 `contributes.configuration`。

````