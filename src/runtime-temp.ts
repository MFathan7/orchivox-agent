import { readdirSync, rmSync, type Dirent } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { addCleanupResults, type CleanupResult } from "./cleanup-types";
import { projectKey } from "./runtime-paths";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RuntimeTempOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
  maxAgeMs?: number;
  /** Age before an empty project temp directory is removed. Defaults to maxAgeMs. */
  emptyProjectMaxAgeMs?: number;
  tmpDir?: string;
  root?: string;
}

export function cacheHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
}

export function runtimeTempBase(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheHome(env), "orchivox", "tmp");
}

export function runtimeTempRoot(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  return join(runtimeTempBase(env), projectKey(root));
}

const currentDirs = new Map<string, string>();
const pendingDirs = new Map<string, Promise<string>>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const dir of currentDirs.values()) {
      removeProcessEntriesSync(dir, process.pid);
    }
  });
}

export async function ensureRuntimeTempDir(
  root = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const key = projectKey(root);
  const existing = currentDirs.get(key);
  if (existing) return existing;
  const pending = pendingDirs.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const dir = runtimeTempRoot(root, env);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    currentDirs.set(key, dir);
    pendingDirs.delete(key);
    installExitHook();
    return dir;
  })().catch((error: unknown) => {
    pendingDirs.delete(key);
    throw error;
  });
  pendingDirs.set(key, promise);
  return promise;
}

export function currentRuntimeTempDir(root = process.cwd()): string | undefined {
  return currentDirs.get(projectKey(root));
}

export async function cleanupRuntimeTempDir(root = process.cwd()): Promise<void> {
  const key = projectKey(root);
  const dir = currentDirs.get(key);
  currentDirs.delete(key);
  pendingDirs.delete(key);
  if (!dir) return;
  await removeProcessEntries(dir, process.pid);
}

export async function cleanupStaleRuntimeTempDirs(
  options: RuntimeTempOptions = {},
): Promise<CleanupResult> {
  const base = runtimeTempBase(options.env ?? process.env);
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const emptyProjectMaxAgeMs = options.emptyProjectMaxAgeMs ?? maxAgeMs;
  let result: CleanupResult = { removed: 0, freedBytes: 0 };
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(base, entry.name);
    if (entry.name.startsWith("run-")) {
      result = addCleanupResults(
        result,
        await cleanupLegacyRunDir(path, entry.name, now, maxAgeMs),
      );
      continue;
    }
    result = addCleanupResults(
      result,
      await cleanupProjectTempDir(path, { now, maxAgeMs }),
    );
    const remaining = await readdir(path).catch(() => []);
    if (remaining.length > 0) continue;
    const info = await lstat(path).catch(() => undefined);
    if (!info || now - info.mtimeMs < emptyProjectMaxAgeMs) continue;
    result = addCleanupResults(result, await removePath(path));
  }
  return result;
}

/**
 * Removes test-created temp directories left by older test runs. This is only
 * used by an explicit cleanup command, never by normal startup.
 */
export async function cleanupLegacyTestArtifacts(
  options: RuntimeTempOptions = {},
): Promise<CleanupResult> {
  const dir = options.tmpDir ?? options.env?.TMPDIR?.trim() ?? tmpdir();
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const prefixes = [
    "orchivox-source-",
    "orchivox-home-",
    "orchivox-other-",
    "orchivox-installer-",
    "orchivox-update-",
    "orchivox-path-",
    "orchivox-release-",
  ];
  let result: CleanupResult = { removed: 0, freedBytes: 0 };
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    const path = join(dir, entry.name);
    const info = await lstat(path).catch(() => undefined);
    if (!info || now - info.mtimeMs < maxAgeMs) continue;
    result = addCleanupResults(result, await removePath(path));
  }
  return result;
}

/**
 * Removes old temp artifacts from earlier Orchivox versions. Only names owned
 * by Orchivox are touched; another tool's files in the temp directory stay.
 */
export async function cleanupLegacyTempArtifacts(
  options: RuntimeTempOptions = {},
): Promise<CleanupResult> {
  const dir = options.tmpDir ?? options.env?.TMPDIR?.trim() ?? tmpdir();
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  let result: CleanupResult = { removed: 0, freedBytes: 0 };
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const owned =
      entry.name.startsWith("orchivox-shell-") ||
      entry.name.startsWith("orchivox-sandbox-");
    if (!owned) continue;
    const path = join(dir, entry.name);
    const info = await lstat(path).catch(() => undefined);
    if (!info || now - info.mtimeMs < maxAgeMs) continue;
    result = addCleanupResults(result, await removePath(path));
  }
  return result;
}

export function resetRuntimeTempForTests(): void {
  currentDirs.clear();
  pendingDirs.clear();
}

async function removePath(path: string): Promise<CleanupResult> {
  const freedBytes = await pathSize(path);
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  return { removed: 1, freedBytes };
}

async function pathSize(path: string): Promise<number> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return 0;
  if (!info.isDirectory() || info.isSymbolicLink()) return info.size;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    total += await pathSize(join(path, entry.name));
  }
  return total;
}

async function cleanupLegacyRunDir(
  path: string,
  name: string,
  now: number,
  maxAgeMs: number,
): Promise<CleanupResult> {
  const pid = pidFromName(name);
  if (pid !== undefined && isProcessAlive(pid)) return { removed: 0, freedBytes: 0 };
  const info = await lstat(path).catch(() => undefined);
  if (!info) return { removed: 0, freedBytes: 0 };
  if (pid === undefined && now - info.mtimeMs < maxAgeMs) {
    return { removed: 0, freedBytes: 0 };
  }
  return removePath(path);
}

async function cleanupProjectTempDir(
  dir: string,
  options: { now: number; maxAgeMs: number },
): Promise<CleanupResult> {
  let result: CleanupResult = { removed: 0, freedBytes: 0 };
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const pid = await entryOwnerPid(entry.name, path);
    if (pid !== undefined) {
      if (isProcessAlive(pid)) continue;
      result = addCleanupResults(result, await removePath(path));
      continue;
    }
    const info = await lstat(path).catch(() => undefined);
    if (!info || options.now - info.mtimeMs < options.maxAgeMs) continue;
    result = addCleanupResults(result, await removePath(path));
  }
  return result;
}

async function removeProcessEntries(dir: string, pid: number): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if ((await entryOwnerPid(entry.name, path)) !== pid) continue;
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

function removeProcessEntriesSync(dir: string, pid: number): void {
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Background process directories are owned by their child PID and are
    // removed by the background process manager or the next startup scan.
    if (entry.name.startsWith("bg-")) continue;
    if (pidFromName(entry.name) !== pid) continue;
    try {
      rmSync(join(dir, entry.name), { recursive: true, force: true });
    } catch {
      // Best effort during process shutdown.
    }
  }
}

async function entryOwnerPid(name: string, path: string): Promise<number | undefined> {
  if (name.startsWith("bg-")) {
    const raw = await readFile(join(path, "owner.pid"), "utf8").catch(() => undefined);
    const owner = Number(raw);
    if (Number.isInteger(owner) && owner > 0) return owner;
  }
  return pidFromName(name);
}

function pidFromName(name: string): number | undefined {
  const match = /^(?:run|shell|sandbox|bg)-(\d+)-/.exec(name);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
