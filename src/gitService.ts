import { execFile } from 'child_process';
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

/**
 * @docs BranchInfo
 * 单个本地分支的信息摘要。
 */
export interface BranchInfo {
  /** 分支短名称（不含 refs/heads/ 前缀） */
  name: string;
  /** 是否为当前检出分支 */
  isCurrent: boolean;
  /** 是否为远程分支 */
  isRemote?: boolean;
  /** 上游分支短名称（例如 origin/main），无上游时为 undefined */
  upstream?: string;
  /** 相较于上游领先提交数 */
  ahead: number;
  /** 相较于上游落后提交数 */
  behind: number;
  /** 该分支最后一次 commit 的 Unix 时间戳（毫秒） */
  lastCommitMs?: number;
  /** 该分支指向的 commit hash（short） */
  commitHash?: string;
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

  // ─── 分支相关方法（不走缓存，实时查询） ───

  /**
   * @docs getRepoRoot
   * 获取指定目录所属 git 仓库的真实根目录。
   * 非 git 仓库时返回 undefined。
   */
  public async getRepoRoot(cwd: string): Promise<string | undefined> {
    try {
      const out = await execGit(['rev-parse', '--show-toplevel'], cwd);
      const root = out.trim();
      return root || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * @docs findGitRepos
   * 扫描一组目录，返回其中所有 git 仓库的根目录信息（去重）。
   */
  public async findGitRepos(
    dirs: string[]
  ): Promise<{ root: string; name: string; currentBranch?: string }[]> {
    const roots = new Map<string, { root: string; name: string; currentBranch?: string }>();

    await Promise.all(
      dirs.map(async dir => {
        const root = await this.getRepoRoot(dir);
        if (!root || roots.has(root)) return;
        const name = path.basename(root);
        const currentBranch = await this.getCurrentBranch(root);
        roots.set(root, { root, name, currentBranch });
      })
    );

    return Array.from(roots.values());
  }

  /**
   * @docs getCurrentBranch
   * 获取当前检出的分支名。detached HEAD 时返回 undefined。
   */
  public async getCurrentBranch(repoRoot: string): Promise<string | undefined> {
    try {
      const out = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
      const name = out.trim();
      if (name === 'HEAD') return undefined;
      return name || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * @docs getBranches
   * 列出所有本地分支，按最后提交时间倒序排列。
   * 包含当前分支标记与上游信息（如有）。
   */
  public async getBranches(repoRoot: string): Promise<BranchInfo[]> {
    try {
      const format = '%(refname:short)|%(committerdate:unix)|%(upstream:short)|%(HEAD)|%(objectname:short)';
      const out = await execGit(
        ['branch', '--format', format, '--sort=-committerdate'],
        repoRoot
      );
      if (!out.trim()) return [];

      const lines = out.split('\n').filter(l => l.trim());
      const branches: BranchInfo[] = [];

      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length < 5) continue;

        const [name, dateStr, upstream, headMarker, commitHash] = parts;
        if (!name) continue;

        const isCurrent = headMarker.trim() === '*';
        const lastCommitMs = dateStr ? parseInt(dateStr.trim(), 10) * 1000 : undefined;
        const upstreamBranch = upstream?.trim() || undefined;

        let ahead = 0;
        let behind = 0;
        if (upstreamBranch && !isCurrent) {
          // 非当前分支不计算 ahead/behind（MVP 简化）
        } else if (upstreamBranch && isCurrent) {
          try {
            const abOut = await execGit(
              ['rev-list', '--left-right', '--count', `${upstreamBranch}...${name}`],
              repoRoot
            );
            const abMatch = abOut.trim().match(/^(\d+)\s+(\d+)$/);
            if (abMatch) {
              behind = parseInt(abMatch[1], 10);
              ahead = parseInt(abMatch[2], 10);
            }
          } catch {
            // 静默降级
          }
        }

        branches.push({
          name: name.trim(),
          isCurrent,
          upstream: upstreamBranch,
          ahead,
          behind,
          lastCommitMs: isNaN(lastCommitMs ?? NaN) ? undefined : lastCommitMs,
          commitHash: commitHash?.trim() || undefined,
        });
      }

      return branches;
    } catch {
      return [];
    }
  }

  /**
   * @docs getRemoteBranches
   * 列出所有远程分支（refs/remotes/ 下）。
   */
  public async getRemoteBranches(repoRoot: string): Promise<BranchInfo[]> {
    try {
      const format = '%(refname:short)|%(committerdate:unix)';
      const out = await execGit(
        ['branch', '-r', '--format', format, '--sort=-committerdate'],
        repoRoot
      );
      if (!out.trim()) return [];

      const currentBranch = await this.getCurrentBranch(repoRoot);

      const lines = out.split('\n').filter(l => l.trim());
      const branches: BranchInfo[] = [];

      for (const line of lines) {
        const [name, dateStr] = line.split('|');
        if (!name) continue;
        const trimmed = name.trim();
        // 跳过 HEAD 指针，如 origin/HEAD
        if (trimmed.endsWith('/HEAD')) continue;

        const lastCommitMs = dateStr ? parseInt(dateStr.trim(), 10) * 1000 : undefined;

        branches.push({
          name: trimmed,
          isCurrent: false,
          isRemote: true,
          upstream: undefined,
          ahead: 0,
          behind: 0,
          lastCommitMs: isNaN(lastCommitMs ?? NaN) ? undefined : lastCommitMs,
        });
      }

      return branches;
    } catch {
      return [];
    }
  }

  /**
   * @docs checkoutBranch
   * 切换到指定本地分支。
   */
  public async checkoutBranch(repoRoot: string, branch: string): Promise<void> {
    await execGit(['checkout', branch], repoRoot);
  }

  /**
   * @docs checkoutRemoteBranch
   * 从远程分支检出本地跟踪分支。
   * remoteBranch 格式如 "origin/feature-x"。
   */
  public async checkoutRemoteBranch(repoRoot: string, remoteBranch: string): Promise<void> {
    const localName = remoteBranch.replace(/^[^/]+\//, '');
    await execGit(['checkout', '-b', localName, '--track', remoteBranch], repoRoot);
  }

  /**
   * @docs createBranch
   * 从当前 HEAD 创建并切换到新分支。
   */
  public async createBranch(repoRoot: string, name: string): Promise<void> {
    await execGit(['checkout', '-b', name], repoRoot);
  }

  /**
   * @docs createBranchFromBase
   * 从指定基础分支创建并切换到新分支。
   */
  public async createBranchFromBase(repoRoot: string, name: string, baseBranch: string): Promise<void> {
    await execGit(['checkout', '-b', name, baseBranch], repoRoot);
  }

  /**
   * @docs deleteBranch
   * 强制删除指定本地分支。
   */
  public async deleteBranch(repoRoot: string, name: string): Promise<void> {
    await execGit(['branch', '-D', name], repoRoot);
  }

  /**
   * @docs safeDeleteBranch
   * 安全删除分支：先尝试 `branch -d`，若失败（未合并）则回退到 `branch -D`。
   * 返回是否成功、是否使用了强制删除，以及错误信息。
   */
  public async safeDeleteBranch(
    repoRoot: string,
    name: string
  ): Promise<{ success: boolean; forced: boolean; error?: string }> {
    try {
      await execGit(['branch', '-d', name], repoRoot);
      return { success: true, forced: false };
    } catch {
      try {
        await execGit(['branch', '-D', name], repoRoot);
        return { success: true, forced: true };
      } catch (err) {
        return {
          success: false,
          forced: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  /**
   * @docs hasUncommittedChanges
   * 检查工作区是否存在 staged 或 unstaged 的变更。
   */
  public async hasUncommittedChanges(repoRoot: string): Promise<boolean> {
    try {
      const out = await execGit(['status', '--porcelain'], repoRoot);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * @docs isMergeInProgress
   * 检查是否有 merge、rebase 或 cherry-pick 正在进行。
   */
  public async isMergeInProgress(repoRoot: string): Promise<boolean> {
    try {
      // merge
      await fs.access(path.join(repoRoot, '.git', 'MERGE_HEAD'));
      return true;
    } catch { /* continue */ }

    try {
      // rebase
      await fs.access(path.join(repoRoot, '.git', 'rebase-merge'));
      return true;
    } catch { /* continue */ }

    try {
      await fs.access(path.join(repoRoot, '.git', 'rebase-apply'));
      return true;
    } catch { /* continue */ }

    try {
      // cherry-pick / revert
      await fs.access(path.join(repoRoot, '.git', 'CHERRY_PICK_HEAD'));
      return true;
    } catch { /* continue */ }

    try {
      await fs.access(path.join(repoRoot, '.git', 'REVERT_HEAD'));
      return true;
    } catch { /* continue */ }

    return false;
  }
}

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) { reject(err); } else { resolve(stdout); }
    });
  });
}
