import { mkdir, readdir, symlink } from "node:fs/promises";

import { resolveProjectState } from "../runtime-paths";
import { pathExists, runGit } from "./git";

export interface MergeResult {
  success: boolean;
  diffSummary: string;
  conflicts: string[];
}

const WORKER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export class WorktreeManager {
  private readonly root: string;
  private readonly worktreesDir: string;

  constructor(options: { repoRoot?: string; worktreesDir?: string } = {}) {
    this.root = options.repoRoot ?? globalThis.process.cwd();
    this.worktreesDir = options.worktreesDir ?? resolveProjectState(this.root).worktreesDir;
  }

  worktreePath(workerId: string): string {
    return `${this.worktreesDir}/${workerId}`;
  }

  branchName(workerId: string): string {
    return `agent/worker-${workerId}`;
  }

  async createWorktree(workerId: string): Promise<string> {
    assertWorkerId(workerId);
    await mkdir(this.worktreesDir, { recursive: true });
    const target = this.worktreePath(workerId);
    if (await pathExists(target)) {
      throw new Error(`worktree already exists for worker "${workerId}"`);
    }
    await runGit(this.root, ["worktree", "add", "-B", this.branchName(workerId), target]);
    await linkDependencies(this.root, target);
    return target;
  }

  async mergeAndCleanup(workerId: string): Promise<MergeResult> {
    assertWorkerId(workerId);
    const target = this.worktreePath(workerId);
    const branch = this.branchName(workerId);
    if (!(await pathExists(target))) {
      throw new Error(`no worktree for worker "${workerId}"`);
    }

    const pending = await runGit(target, ["status", "--porcelain"]);
    if (pending.stdout.trim()) {
      await runGit(target, ["add", "-A"]);
      await runGit(target, ["commit", "-m", `chore(worker-${workerId}): commit pending worker changes before merge`]);
    }

    const oldHead = (await runGit(this.root, ["rev-parse", "HEAD"])).stdout.trim();
    const merge = await runGit(this.root, ["merge", "--no-edit", branch], { allowFailure: true });

    if (merge.exitCode !== 0) {
      const conflicts = (await runGit(this.root, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true }))
        .stdout.split("\n")
        .filter(Boolean);
      const diffSummary = (
        await runGit(this.root, ["diff", "--stat", oldHead, branch], { allowFailure: true })
      ).stdout.trim();
      return { success: false, diffSummary, conflicts };
    }

    const diffSummary = (await runGit(this.root, ["diff", "--stat", oldHead, "HEAD"])).stdout.trim();
    await runGit(this.root, ["worktree", "remove", target]);
    await runGit(this.root, ["branch", "-d", branch]);
    return { success: true, diffSummary, conflicts: [] };
  }
}

function assertWorkerId(workerId: string): void {
  if (!WORKER_ID_PATTERN.test(workerId)) {
    throw new Error(`invalid worker id "${workerId}": use letters, digits, dots, underscores, or dashes`);
  }
}

/**
 * A fresh worktree has no node_modules, so a worker could not run the checks
 * that prove its change. Mirror the main checkout's packages as an ignored
 * directory of symlinks, which keeps git status clean unlike a linked folder.
 */
async function linkDependencies(repoRoot: string, worktree: string): Promise<void> {
  const source = `${repoRoot}/node_modules`;
  const target = `${worktree}/node_modules`;
  if (!(await pathExists(source)) || (await pathExists(target))) return;
  try {
    await mkdir(target);
    const entries = await readdir(source);
    await Promise.all(
      entries.map((entry) =>
        symlink(`${source}/${entry}`, `${target}/${entry}`, "dir").catch(() => undefined),
      ),
    );
  } catch {
    // Dependencies are a convenience. A worker can still install its own.
  }
}
