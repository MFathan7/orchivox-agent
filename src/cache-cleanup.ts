import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { addCleanupResults, type CleanupResult } from "./cleanup-types";
import {
  cleanupLegacyTempArtifacts,
  cleanupLegacyTestArtifacts,
  cleanupStaleRuntimeTempDirs,
  cacheHome,
} from "./runtime-temp";

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_LOG_BYTES = 1024 * 1024;

export type { CleanupResult } from "./cleanup-types";

export interface CacheCleanupOptions {
  /** Orchivox cache root. Defaults to $XDG_CACHE_HOME/orchivox. */
  cacheRoot?: string;
  now?: number;
  maxAgeMs?: number;
  maxBytes?: number;
}

export interface RunCleanupOptions extends CacheCleanupOptions {
  env?: NodeJS.ProcessEnv;
  tmpDir?: string;
  /** Remove empty project temp directories immediately. */
  aggressive?: boolean;
  includeLegacyTestArtifacts?: boolean;
}

export function defaultCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheHome(env), "orchivox");
}

export async function cleanupCacheDirectory(
  directory: string,
  options: CacheCleanupOptions = {},
): Promise<CleanupResult> {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
  }
  files.sort((left, right) => left.mtimeMs - right.mtimeMs);

  let total = files.reduce((sum, file) => sum + file.size, 0);
  let removed = 0;
  let freedBytes = 0;
  for (const file of files) {
    const tooOld = now - file.mtimeMs >= maxAgeMs;
    const overLimit = total > maxBytes;
    if (!tooOld && !overLimit) continue;
    await rm(file.path, { force: true }).catch(() => undefined);
    removed += 1;
    freedBytes += file.size;
    total -= file.size;
  }
  return { removed, freedBytes };
}

export async function cleanupToolOutputCache(
  options: CacheCleanupOptions = {},
): Promise<CleanupResult> {
  return cleanupCacheDirectory(
    join(options.cacheRoot ?? defaultCacheRoot(), "tool-output"),
    options,
  );
}

export async function cleanupDocumentCache(
  options: CacheCleanupOptions = {},
): Promise<CleanupResult> {
  return cleanupCacheDirectory(
    join(options.cacheRoot ?? defaultCacheRoot(), "documents"),
    options,
  );
}

export async function cleanupCacheFiles(
  options: CacheCleanupOptions = {},
): Promise<CleanupResult> {
  const [output, documents] = await Promise.all([
    cleanupToolOutputCache(options),
    cleanupDocumentCache(options),
  ]);
  return {
    removed: output.removed + documents.removed,
    freedBytes: output.freedBytes + documents.freedBytes,
  };
}

export async function rotateLogFile(
  path: string,
  maxBytes = DEFAULT_LOG_BYTES,
): Promise<CleanupResult> {
  const info = await stat(path).catch(() => undefined);
  if (!info || info.size <= maxBytes) return { removed: 0, freedBytes: 0 };
  const content = await readFile(path).catch(() => undefined);
  if (!content) return { removed: 0, freedBytes: 0 };
  const kept = content.subarray(Math.max(0, content.length - maxBytes));
  await writeFile(path, kept).catch(() => undefined);
  return { removed: 1, freedBytes: content.length - kept.length };
}

export async function rotateCacheLogs(
  options: CacheCleanupOptions = {},
): Promise<CleanupResult> {
  const root = options.cacheRoot ?? defaultCacheRoot();
  const results = await Promise.all(
    ["errors.log", "freeze.log", "usage.log"].map((name) =>
      rotateLogFile(join(root, name), DEFAULT_LOG_BYTES),
    ),
  );
  return sumResults(results);
}

export async function runCleanup(
  options: RunCleanupOptions = {},
): Promise<CleanupResult> {
  let result: CleanupResult = { removed: 0, freedBytes: 0 };
  result = addCleanupResults(
    result,
    await cleanupStaleRuntimeTempDirs({
      env: options.env,
      now: options.now,
      maxAgeMs: options.maxAgeMs,
      emptyProjectMaxAgeMs: options.aggressive ? 0 : options.maxAgeMs,
    }).catch(() => ({ removed: 0, freedBytes: 0 })),
  );
  result = addCleanupResults(
    result,
    await cleanupLegacyTempArtifacts({
      env: options.env,
      tmpDir: options.tmpDir,
      now: options.now,
      maxAgeMs: options.maxAgeMs,
    }).catch(() => ({ removed: 0, freedBytes: 0 })),
  );
  result = addCleanupResults(
    result,
    await cleanupCacheFiles(options).catch(() => ({ removed: 0, freedBytes: 0 })),
  );
  result = addCleanupResults(
    result,
    await rotateCacheLogs(options).catch(() => ({ removed: 0, freedBytes: 0 })),
  );
  if (options.includeLegacyTestArtifacts) {
    result = addCleanupResults(
      result,
      await cleanupLegacyTestArtifacts({
        env: options.env,
        tmpDir: options.tmpDir,
        now: options.now,
        maxAgeMs: 0,
      }).catch(() => ({ removed: 0, freedBytes: 0 })),
    );
  }
  return result;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function sumResults(results: CleanupResult[]): CleanupResult {
  return results.reduce(
    (total, result) => ({
      removed: total.removed + result.removed,
      freedBytes: total.freedBytes + result.freedBytes,
    }),
    { removed: 0, freedBytes: 0 },
  );
}
