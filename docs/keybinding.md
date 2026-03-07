# 自定义快捷键功能

## 使用文档

### 概述

你可以为"已保存"列表中的项目配置自定义快捷键，通过键盘直接跳转到对应的工作区窗口，无需鼠标操作。

---

### 第一步：在 saved.json 中为项目添加 keybinding 字段

打开 saved.json（活动栏 → Window Tracker 视图 → 右键 → Open saved.json），为目标项目添加 `keybinding` 字段：

```json
[
  {
    "id": "file:///Users/yourname/projects/my-project",
    "lastActive": 1741234567890,
    "keybinding": "cmd+j cmd+k"
  }
]
```

`keybinding` 值的格式与 VS Code keybindings.json 中的 `key` 字段一致，例如：

| 示例值 | 含义 |
|--------|------|
| `"cmd+j cmd+k"` | 先按 ⌘J，再按 ⌘K（Chord 序列键） |
| `"ctrl+shift+p"` | Ctrl+Shift+P |
| `"alt+f1"` | Alt+F1 |

---

### 第二步：在 keybindings.json 中注册快捷键

保存 saved.json 后，TreeItem 的描述栏会显示你配置的快捷键符号（如 `⌘J ⌘K`），并在右侧出现 $(key) 图标。

点击该图标执行"验证快捷键"命令：

- **已注册**：弹出成功提示，点击"打开 keybindings.json"可直接跳转到对应行。
- **未注册**：弹出警告并将以下 JSON 片段复制到剪贴板：

  ```json
  {
    "key": "cmd+j cmd+k",
    "command": "vscode-window-tracker.openByStableId",
    "args": {
      "stableId": "file:///Users/yourname/projects/my-project"
    }
  }
  ```

  点击"打开 keybindings.json"后，将剪贴板内容粘贴到数组中并保存即可。

---

### 第三步：使用快捷键切换工作区

注册完成后，在任意窗口按下配置的快捷键，VS Code 会在新窗口中打开对应项目。

---

### TreeItem 外观

| 状态 | description 区域 | 右侧图标 |
|------|-----------------|---------|
| 已保存，无快捷键 | `3 小时前` | 无 |
| 已保存，有快捷键 | `3 小时前 · ⌘J ⌘K` | $(key) |
| 被追踪且已保存，有快捷键 | `刚刚 · ⌘J ⌘K` | $(key) |

---

## 实现文档

### 涉及文件

| 文件 | 职责 |
|------|------|
| `src/types.ts` | 类型定义 |
| `src/helpers.ts` | 格式化工具函数 |
| `src/savedService.ts` | saved.json 读写 |
| `src/dataManager.ts` | 数据聚合与 UI 辅助 |
| `src/keybindingChecker.ts` | keybindings.json 扫描与定位 |
| `src/extension.ts` | 命令注册 |
| `package.json` | 命令声明与菜单配置 |

---

### 数据模型变更

**`SavedItem`**（`src/types.ts`）：

```typescript
export type SavedItem = {
  id: string;
  lastActive?: number;
  keybinding?: string;   // 新增：用户自定义快捷键字符串
};
```

**`WindowNode`**（`src/types.ts`）：

```typescript
export interface WindowNode extends WindowRecord {
  // ...
  keybinding?: string;   // 新增：从 saved.json 合并而来
}
```

---

### 数据流

```
saved.json
  └─ SavedService.buildSavedNodes()
       └─ normalizeSavedCandidate()    # helpers.ts：透传 keybinding
            └─ WindowNode.keybinding

DataManager.getWindowNodes()
  ├─ 若 saved 节点命中 tracked 节点
  │    └─ tracked.keybinding = saved.keybinding   # 合并到 tracked 侧
  └─ 否则 saved 节点直接加入列表

buildDescription(node)   # dataManager.ts
  └─ formatKeybindingLabel(node.keybinding)  # helpers.ts，macOS 转符号
       → description: "3 小时前 · ⌘J ⌘K"

buildContextValue(node)  # dataManager.ts
  └─ origin=saved  → "windowItem:saved[:kb]"
  └─ origin=tracked, isSaved → "windowItem:tracked:saved[:kb]"

package.json when 条件
  └─ viewItem =~ /:kb/   → 显示 $(key) 图标 + 触发 verifyKeybinding
```

---

### keybindingChecker.ts

| 函数 | 说明 |
|------|------|
| `getUserDirFromGlobalStorage(fsPath)` | 从 `globalStorageUri.fsPath` 反向推导编辑器 User 目录。截取 `/globalStorage/` 之前的片段，再去掉可能的 `/profiles/<hash>` 部分。不依赖品牌名硬编码，兼容 Cursor 等 fork。 |
| `getFallbackUserDir()` | 兜底：当 `globalStorageFsPath` 无法解析时，硬编码返回 VS Code 默认 User 目录（分 win32/darwin/linux）。 |
| `getAllKeybindingsPaths(fsImpl, globalStorageFsPath?)` | 返回所有候选 keybindings.json 路径：`User/keybindings.json` + `User/profiles/*/keybindings.json`。 |
| `isKeybindingRegistered(stableId, fsImpl?, globalStorageFsPath?)` | JSONC 文本匹配：同时包含 `openByStableId` 命令名和 `stableId` 字符串即视为已注册。 |
| `findKeybindingLocation(stableId, fsImpl?, globalStorageFsPath?)` | 在找到匹配文件后，逐行查找含 `stableId` 的行号，返回 `{ filePath, line }`，供调用方精准跳转。 |
| `buildKeybindingSnippet(stableId, key)` | 生成标准 JSON 片段，供用户粘贴到 keybindings.json。 |

**Profile 路径推断逻辑：**

```
globalStorageFsPath 示例（自定义 Profile）:
  …/User/profiles/5dcc94f6/globalStorage/publisher.ext-name

截取 /globalStorage/ 之前：
  …/User/profiles/5dcc94f6

含 /profiles/ → 再截第一个 /profiles/ 之前：
  …/User

→ profilesDir = …/User/profiles
→ 扫描所有子目录得到全部 keybindings.json 路径
```

---

### 命令

| 命令 ID | 触发方式 | 说明 |
|---------|---------|------|
| `vscode-window-tracker.openByStableId` | 用户在 keybindings.json 中绑定 | 按快捷键后通过 stableId 查找节点并用 `vscode.openFolder` 打开 |
| `vscode-window-tracker.verifyKeybinding` | TreeItem 右侧 $(key) 图标 | 扫描所有 keybindings.json，已注册则跳转到对应行；未注册则复制片段并提供打开入口 |

---

### 安全性

- `openByStableId` 对 URI scheme 做白名单校验（`file / vscode-vfs / vscode-test-web / vscode-remote`），非标准 scheme 需用户二次确认，防止 saved.json 被篡改后触发 RCE/SSRF。
- keybindingChecker 所有 I/O 均有 `try/catch`，文件不存在时静默跳过。
