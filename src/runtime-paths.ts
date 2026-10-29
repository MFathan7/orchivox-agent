import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface ProjectStatePaths {
  root: string;
  dataDir: string;
  memoryDb: string;
  history: string;
  snapshotsDir: string;
  worktreesDir: string;
  legacyAgentDir: string;
  legacyMemoryDb: string;
  legacyHistory: string;
  legacySnapshotsDir: string;
}

export function resolveProjectState(root = process.cwd()): ProjectStatePaths {
  const canonical = resolve(root).replace(/[\\/]+$/, "");
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  const name = basename(canonical).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48) || "project";
  const stateHome =
    process.env.ORCHIVOX_STATE_HOME?.trim() ||
    join(
      process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"),
      "orchivox",
      "projects",
    );
  const dataDir = join(stateHome, `${name}-${hash}`);
  return {
    root: canonical,
    dataDir,
    memoryDb: join(dataDir, "memory.db"),
    history: join(dataDir, "history.json"),
    snapshotsDir: join(dataDir, "snapshots"),
    worktreesDir: join(dataDir, "worktrees"),
    legacyAgentDir: join(canonical, ".agent"),
    legacyMemoryDb: join(canonical, ".agent", "memory.db"),
    legacyHistory: join(canonical, ".agent", "history.json"),
    legacySnapshotsDir: join(canonical, ".agent", "snapshots"),
  };
}

function copyIfMissing(source: string, target: string): boolean {
  if (!existsSync(source) || existsSync(target)) return false;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  return true;
}

function hasEntries(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

export async function ensureProjectState(root = process.cwd()): Promise<ProjectStatePaths> {
  const paths = resolveProjectState(root);
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(paths.worktreesDir, { recursive: true });

  const copiedDatabase = copyIfMissing(paths.legacyMemoryDb, paths.memoryDb);
  if (copiedDatabase) {
    copyIfMissing(`${paths.legacyMemoryDb}-wal`, `${paths.memoryDb}-wal`);
    copyIfMissing(`${paths.legacyMemoryDb}-shm`, `${paths.memoryDb}-shm`);
  }
  copyIfMissing(paths.legacyHistory, paths.history);

  if (!hasEntries(paths.snapshotsDir) && hasEntries(paths.legacySnapshotsDir)) {
    await cp(paths.legacySnapshotsDir, paths.snapshotsDir, { recursive: true });
  }

  return paths;
}
