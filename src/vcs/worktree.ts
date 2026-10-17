import { ensureAgentExcluded, pathExists, runGit } from "./git";

export interface MergeResult {
  success: boolean;
  diffSummary: string;
  conflicts: string[];
}

const WORKER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export class WorktreeManager {
  private readonly root: string;

  constructor(options: { repoRoot?: string } = {}) {
    this.root = options.repoRoot ?? globalThis.process.cwd();
  }

  worktreePath(workerId: string): string {
    return `${this.root}/.agent/worktrees/${workerId}`;
  }

  branchName(workerId: string): string {
    return `agent/worker-${workerId}`;
  }

  async createWorktree(workerId: string): Promise<string> {
    assertWorkerId(workerId);
    await ensureAgentExcluded(this.root);
    const target = this.worktreePath(workerId);
    if (await pathExists(target)) {
      throw new Error(`worktree already exists for worker "${workerId}"`);
    }
    await runGit(this.root, ["worktree", "add", "-B", this.branchName(workerId), target]);
    return target;
  }

  async mergeAndCleanup(workerId: string): Promise<MergeResult> {
    assertWorkerId(workerId);
    await ensureAgentExcluded(this.root);
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
