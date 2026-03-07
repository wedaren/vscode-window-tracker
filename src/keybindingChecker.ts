import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/**
 * @docs getUserDirFromGlobalStorage
 * 从 globalStorageUri.fsPath 反向推导编辑器 User 目录（不依赖品牌名硬编码）。
 * 路径格式（两种）：
 *   默认  Profile: …/User/globalStorage/<ext-id>
 *   自定义 Profile: …/User/profiles/<hash>/globalStorage/<ext-id>
 * 两种情况均截取 /globalStorage/ 之前的片段，再去掉可能的 /profiles/<hash> 部分。
 */
function getUserDirFromGlobalStorage(globalStorageFsPath: string): string | undefined {
  const marker = `${path.sep}globalStorage${path.sep}`;
  const idx = globalStorageFsPath.indexOf(marker);
  if (idx === -1) { return undefined; }

  const beforeGlobalStorage = globalStorageFsPath.slice(0, idx);
  // 自定义 Profile: beforeGlobalStorage = …/User/profiles/<hash>  → User = 再上两级
  // 默认  Profile: beforeGlobalStorage = …/User                   → User = 本身
  const profilesMarker = `${path.sep}profiles${path.sep}`;
  const profilesIdx = beforeGlobalStorage.lastIndexOf(profilesMarker);
  if (profilesIdx !== -1) {
    return beforeGlobalStorage.slice(0, profilesIdx);
  }
  return beforeGlobalStorage;
}

/**
 * @docs getFallbackUserDir
 * 兜底：当无法从 globalStorageFsPath 解析时使用硬编码路径（仅支持 VS Code）。
 */
function getFallbackUserDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User');
  } else if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User');
  } else {
    return path.join(home, '.config', 'Code', 'User');
  }
}

/**
 * @docs getAllKeybindingsPaths
 * 返回所有可能的 keybindings.json 路径：
 *   1. User/keybindings.json（默认 Profile）
 *   2. User/profiles/<hash>/keybindings.json（逐一扫描所有自定义 Profile）
 *
 * 不区分"当前 Profile"——打开文件统一由调用方执行
 * workbench.action.openGlobalKeybindingsFile，无需计算路径。
 */
export async function getAllKeybindingsPaths(
  fsImpl = fs,
  globalStorageFsPath?: string
): Promise<string[]> {
  const userDir = (globalStorageFsPath
    ? getUserDirFromGlobalStorage(globalStorageFsPath)
    : undefined) ?? getFallbackUserDir();

  const results: string[] = [];
  results.push(path.join(userDir, 'keybindings.json'));

  try {
    const profilesDir = path.join(userDir, 'profiles');
    const entries = await fsImpl.readdir(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        results.push(path.join(profilesDir, entry.name, 'keybindings.json'));
      }
    }
  } catch {
    // profiles 目录不存在时忽略
  }

  return results;
}

/**
 * @docs isKeybindingRegistered
 * 检查 keybindings.json（当前 Profile 优先，兜底扫描全部 Profile）中
 * 是否存在对应 stableId 的快捷键映射（JSONC 文本匹配）。
 *
 * @param stableId 节点稳定标识符
 * @param fsImpl 可注入的文件系统实现（便于测试）
 * @param globalStorageFsPath ExtensionContext.globalStorageUri.fsPath，用于推断当前 Profile
 */
export async function isKeybindingRegistered(
  stableId: string,
  fsImpl = fs,
  globalStorageFsPath?: string
): Promise<boolean> {
  const paths = await getAllKeybindingsPaths(fsImpl, globalStorageFsPath);
  for (const kbPath of paths) {
    try {
      const content = await fsImpl.readFile(kbPath, 'utf8');
      if (
        content.includes('vscode-window-tracker.openByStableId') &&
        content.includes(stableId)
      ) {
        return true;
      }
    } catch {
      // 文件不存在或无法读取，跳过
    }
  }
  return false;
}

/**
 * @docs findKeybindingLocation
 * 在所有 keybindings.json 中找到包含指定 stableId 的文件和行号（0-indexed）。
 * 找不到时返回 undefined。
 */
export async function findKeybindingLocation(
  stableId: string,
  fsImpl = fs,
  globalStorageFsPath?: string
): Promise<{ filePath: string; line: number } | undefined> {
  const paths = await getAllKeybindingsPaths(fsImpl, globalStorageFsPath);
  for (const kbPath of paths) {
    try {
      const content = await fsImpl.readFile(kbPath, 'utf8');
      if (
        !content.includes('vscode-window-tracker.openByStableId') ||
        !content.includes(stableId)
      ) {
        continue;
      }
      const lines = content.split('\n');
      const lineIndex = lines.findIndex(l => l.includes(stableId));
      if (lineIndex !== -1) {
        return { filePath: kbPath, line: lineIndex };
      }
    } catch {
      // 文件不存在或无法读取，跳过
    }
  }
  return undefined;
}

/**
 * @docs buildKeybindingSnippet
 * 生成供用户粘贴到 keybindings.json 的配置 JSON 片段字符串。
 */
export function buildKeybindingSnippet(stableId: string, key: string): string {
  const entry = {
    key,
    command: 'vscode-window-tracker.openByStableId',
    args: { stableId },
  };
  return JSON.stringify(entry, null, 2);
}
