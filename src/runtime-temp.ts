import { rmSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RuntimeTempOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
  maxAgeMs?: number;
  tmpDir?: string;
}

export function runtimeTempRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(base, "orchivox", "tmp");
}

let currentDir: string | undefined;
let currentDirPromise: Promise<string> | undefined;
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    if (!currentDir) return;
    try {
      rmSync(currentDir, { recursive: true, force: true });
    } catch {
      // Best effort during process shutdown.
    }
  });
}

export async function ensureRuntimeTempDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (currentDir) return currentDir;
  if (!currentDirPromise) {
    currentDirPromise = (async () => {
      const root = runtimeTempRoot(env);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const dir = join(root, `run-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      currentDir = dir;
      installExitHook();
      return dir;
    })().catch((error: unknown) => {
      currentDirPromise = undefined;
      throw error;
    });
  }
  return currentDirPromise;
}

export function currentRuntimeTempDir(): string | undefined {
  return currentDir;
}

export async function cleanupRuntimeTempDir(dir: string | undefined = currentDir): Promise<void> {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  if (dir === currentDir) {
    currentDir = undefined;
    currentDirPromise = undefined;
  }
}

export async function cleanupStaleRuntimeTempDirs(
  options: RuntimeTempOptions = {},
): Promise<number> {
  const root = runtimeTempRoot(options.env ?? process.env);
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  let removed = 0;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("run-")) continue;
    const path = join(root, entry.name);
    if (path === currentDir) continue;
    const pid = Number(entry.name.split("-")[1]);
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) continue;
    const info = await stat(path).catch(() => undefined);
    if (!info || now - info.mtimeMs < maxAgeMs) continue;
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    removed += 1;
  }
  return removed;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes old temp artifacts from earlier Orchivox versions. Only names owned
 * by Orchivox are touched; another tool's files in the temp directory stay.
 */
export async function cleanupLegacyTempArtifacts(
  options: RuntimeTempOptions = {},
): Promise<number> {
  const dir = options.tmpDir ?? options.env?.TMPDIR?.trim() ?? tmpdir();
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  let removed = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const owned =
      entry.name.startsWith("orchivox-shell-") ||
      entry.name.startsWith("orchivox-sandbox-");
    if (!owned) continue;
    const path = join(dir, entry.name);
    const info = await stat(path).catch(() => undefined);
    if (!info || now - info.mtimeMs < maxAgeMs) continue;
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    removed += 1;
  }
  return removed;
}

export function resetRuntimeTempForTests(): void {
  currentDir = undefined;
  currentDirPromise = undefined;
}
