import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * @docs GitFileChange
 * 单个文件的变更信息，包含相对路径与磁盘最后修改时间。
 */
export interface GitFileChange {
  /** 相对于仓库根目录的文件路径 */
  relativePath: string;
  /** 文件在磁盘上的最后修改时间戳（毫秒），读取失败时为 undefined */
  mtimeMs?: number;
}

/**
 * @docs GitWorkspaceSummary
 * 工作区 git 状态摘要，含最后 commit 时间与工作区有变更文件列表。
 */
export interface GitWorkspaceSummary {
  /** 最后一次 commit 的 Unix 时间戳（毫秒），非 git 仓库时为 undefined */
  lastCommitMs?: number;
  /** staged + unstaged 有变更的文件列表，非 git 仓库时为空数组 */
  changedFiles: GitFileChange[];
  /** 所有来源中最大的时间戳（毫秒）：max(lastCommit, changedFiles.mtime) */
  lastChangeMs?: number;
}

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  summary: GitWorkspaceSummary;
  expiresAt: number;
}

/**
 * @docs GitService
 * 封装对 git 仓库状态的查询，包含 30s TTL 缓存。
 *
 * - 使用 `git log` 获取最后 commit 时间。
 * - 使用 `git status --porcelain` 获取 staged/unstaged 变更文件，再用 `fs.stat` 取磁盘 mtime。
 * - 所有 git 命令失败时静默降级，不影响主流程。
 */
export class GitService {
  private cache = new Map<string, CacheEntry>();

  /**
   * @docs getSummary
   * 获取指定目录的 git 工作区摘要，优先使用缓存。
   */
  public async getSummary(repoRoot: string): Promise<GitWorkspaceSummary> {
    const cached = this.cache.get(repoRoot);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.summary;
    }

    const summary = await this.fetchSummary(repoRoot);
    this.cache.set(repoRoot, { summary, expiresAt: Date.now() + CACHE_TTL_MS });
    return summary;
  }

  /**
   * @docs invalidate
   * 使指定目录的缓存失效（可在 FileSystemWatcher 触发时调用）。
   */
  public invalidate(repoRoot: string): void {
    this.cache.delete(repoRoot);
  }

  private async fetchSummary(repoRoot: string): Promise<GitWorkspaceSummary> {
    const [lastCommitMs, changedFiles] = await Promise.all([
      this.getLastCommitMs(repoRoot),
      this.getChangedFiles(repoRoot),
    ]);

    const fileMtimes = changedFiles.map(f => f.mtimeMs ?? 0);
    const candidates = [lastCommitMs ?? 0, ...fileMtimes].filter(t => t > 0);
    const lastChangeMs = candidates.length > 0 ? Math.max(...candidates) : undefined;

    return { lastCommitMs, changedFiles, lastChangeMs };
  }

  private async getLastCommitMs(repoRoot: string): Promise<number | undefined> {
    try {
      const out = await execGit(['log', '-1', '--format=%ct'], repoRoot);
      const ts = parseInt(out.trim(), 10);
      return isNaN(ts) ? undefined : ts * 1000;
    } catch {
      return undefined;
    }
  }

  private async getChangedFiles(repoRoot: string): Promise<GitFileChange[]> {
    try {
      const out = await execGit(['status', '--porcelain', '-u'], repoRoot);
      if (!out.trim()) { return []; }

      const lines = out.split('\n').filter(l => l.trim());
      const relativePaths = lines.map(line => {
        // porcelain 格式：XY filename 或 XY "filename with spaces"
        // 取第 3 个字符之后的部分
        const raw = line.slice(3).trim();
        // 处理重命名：`R old -> new` 格式，取 -> 后的部分
        const arrowIdx = raw.indexOf(' -> ');
        return arrowIdx >= 0 ? raw.slice(arrowIdx + 4).replace(/^"|"$/g, '') : raw.replace(/^"|"$/g, '');
      }).filter(Boolean);

      const unique = [...new Set(relativePaths)];
      const results = await Promise.all(
        unique.map(async (rel): Promise<GitFileChange> => {
          const abs = path.join(repoRoot, rel);
          try {
            const stat = await fs.stat(abs);
            return { relativePath: rel, mtimeMs: stat.mtimeMs };
          } catch {
            return { relativePath: rel };
          }
        })
      );
      return results;
    } catch {
      return [];
    }
  }
}

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`git ${args.join(' ')}`, { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) { reject(err); } else { resolve(stdout); }
    });
  });
}
