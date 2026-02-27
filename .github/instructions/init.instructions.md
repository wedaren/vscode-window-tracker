---
description: Describe when these instructions should be loaded
# applyTo: 'Describe when these instructions should be loaded' # when provided, instructions will automatically be added to the request context when the pattern matches an attached file
---
Provide project context and coding guidelines that AI should follow when generating code, answering questions, or reviewing changes.

以下为针对本项目的额外约定（供 LLM/代码审查时参考）：

- 简要中文注释：在生成或修改代码时，务必在函数、类或复杂逻辑处添加用中文的简短注释，每处不超过两行，说明目的或关键实现点，保持精炼。
- 文件开头原理说明：若某个文件包含较复杂的实现或非显而易见的设计决策，请在文件顶部添加 3-5 行的中文原理说明，概述目的、核心思路与边界条件，便于维护者快速理解。
- 注释风格：保持与项目既有风格一致（例如 TypeScript 中使用 `//` 或 `/** */`），不要重复代码可读性明显的信息，也不要包含敏感数据。
- 何时不注释：对于非常简单、直观的辅助函数或一行实现，无需额外注释以避免噪音。
- 示例（简短示范，不必逐字复制）：
	- 文件顶部：
		"""
		简要原理：该模块负责监听 VS Code 窗口事件并维护追踪器状态。
		关键点：使用事件去抖以减少频繁更新；持久化到设置存储。
		"""
	- 函数处：
		// 更新追踪器状态并触发树刷新（防止重复渲染）

请在 PR 提交或代码生成时遵守以上约定。必要时可在注释中加入英文关键词以利国际协作，但主注释请以中文为主。