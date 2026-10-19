import { mkdir } from "node:fs/promises";

import { resolveProjectState } from "../runtime-paths";
import { runGit } from "./git";

export interface SnapshotEntry {
  id: string;
  label: string;
  tree: string;
  createdAt: number;
}

export interface SnapshotHistory {
  entries: SnapshotEntry[];
  cursor: number;
}

export interface RestoreResult {
  snapshotId: string;
  restoredFiles: string[];
}

export class SnapshotManager {
  private readonly root: string;
  private readonly indexDir: string;

  constructor(options: { repoRoot?: string; stateDir?: string } = {}) {
    this.root = options.repoRoot ?? globalThis.process.cwd();
    this.indexDir = options.stateDir ?? resolveProjectState(this.root).snapshotsDir;
  }

  async captureSnapshot(label: string): Promise<string> {
    const tree = await this.writeTree();
    const history = await this.readHistory();
    if (history.cursor < history.entries.length - 1) {
      history.entries = history.entries.slice(0, history.cursor + 1);
    }
    const entry: SnapshotEntry = {
      id: `snap-${Date.now().toString(36)}-${tree.slice(0, 7)}`,
      label,
      tree,
      createdAt: Date.now(),
    };
    history.entries.push(entry);
    history.cursor = history.entries.length - 1;
    await this.writeHistory(history);
    return entry.id;
  }

  async undo(): Promise<RestoreResult> {
    return this.step(-1);
  }

  async redo(): Promise<RestoreResult> {
    return this.step(1);
  }

  async getHistory(): Promise<SnapshotHistory> {
    return this.readHistory();
  }

  async restoreTo(snapshotId: string): Promise<RestoreResult> {
    const history = await this.readHistory();
    const index = history.entries.findIndex((entry) => entry.id === snapshotId);
    if (index === -1) throw new Error(`unknown snapshot "${snapshotId}"`);
    const target = history.entries[index];
    const restoredFiles = await this.restore(target.tree);
    history.cursor = index;
    await this.writeHistory(history);
    return { snapshotId: target.id, restoredFiles };
  }

  async getChangedFiles(snapshotId: string): Promise<string[]> {
    const history = await this.readHistory();
    const index = history.entries.findIndex((entry) => entry.id === snapshotId);
    if (index === -1) return [];
    const current = history.entries[index];
    const previous = index > 0 ? history.entries[index - 1] : undefined;
    if (!previous) {
      const { stdout } = await runGit(this.root, ["diff-tree", "--no-commit-id", "--name-only", "-r", current.tree]).catch(() => ({ stdout: "" }));
      return stdout.split("\n").filter(Boolean);
    }
    const { stdout } = await runGit(this.root, ["diff-tree", "--no-commit-id", "--name-only", "-r", previous.tree, current.tree]).catch(() => ({ stdout: "" }));
    return stdout.split("\n").filter(Boolean);
  }

  private async step(direction: -1 | 1): Promise<RestoreResult> {
    const history = await this.readHistory();
    const nextCursor = history.cursor + direction;
    if (nextCursor < 0) throw new Error("nothing to undo");
    if (nextCursor > history.entries.length - 1) throw new Error("nothing to redo");
    const target = history.entries[nextCursor];
    const restoredFiles = await this.restore(target.tree);
    history.cursor = nextCursor;
    await this.writeHistory(history);
    return { snapshotId: target.id, restoredFiles };
  }

  private async writeTree(): Promise<string> {
    await mkdir(this.indexDir, { recursive: true });
    const env = { GIT_INDEX_FILE: `${this.indexDir}/index` };
    await runGit(this.root, ["add", "-A"], { env });
    const { stdout } = await runGit(this.root, ["write-tree"], { env });
    return stdout.trim();
  }

  private async restore(targetTree: string): Promise<string[]> {
    const currentTree = await this.writeTree();
    const env = { GIT_INDEX_FILE: `${this.indexDir}/index` };
    const [changed, added] = await Promise.all([
      runGit(this.root, ["diff", "--name-only", targetTree, currentTree]),
      runGit(this.root, ["diff", "--name-only", "--diff-filter=A", targetTree, currentTree]),
    ]);

    await runGit(this.root, ["read-tree", targetTree], { env });
    await runGit(this.root, ["checkout-index", "-a", "-f"], { env });

    for (const file of added.stdout.split("\n").filter(Boolean)) {
      const handle = Bun.file(`${this.root}/${file}`);
      if (await handle.exists()) await handle.delete();
    }

    return changed.stdout.split("\n").filter(Boolean);
  }

  private async readHistory(): Promise<SnapshotHistory> {
    const file = Bun.file(`${this.indexDir}/history.json`);
    if (!(await file.exists())) return { entries: [], cursor: -1 };
    const parsed: unknown = JSON.parse(await file.text());
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as SnapshotHistory).entries) &&
      typeof (parsed as SnapshotHistory).cursor === "number"
    ) {
      return parsed as SnapshotHistory;
    }
    return { entries: [], cursor: -1 };
  }

  private async writeHistory(history: SnapshotHistory): Promise<void> {
    await mkdir(this.indexDir, { recursive: true });
    await Bun.write(`${this.indexDir}/history.json`, `${JSON.stringify(history, null, 2)}\n`);
  }
}
