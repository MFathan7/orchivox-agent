import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** Argument keys that always describe a workspace path. */
const PATH_KEYS = new Set([
  "filePath",
  "path",
  "basePath",
  "targetPath",
  "destinationPath",
  "sourcePath",
  "cwd",
  "workdir",
  "directory",
  "dir",
  "repoRoot",
]);

/** Normalizes a path for a tool signature, relative to the workspace root. */
export function normalizeToolPath(value: string, root: string): string {
  const slashed = value.replace(/\\/g, "/");
  const absolute = isAbsolute(slashed) ? resolve(slashed) : resolve(root, slashed);
  const rel = relative(resolve(root), absolute).replace(/\\/g, "/");
  if (rel.startsWith("..") || isAbsolute(rel)) return absolute.replace(/\\/g, "/");
  const cleaned = rel.replace(/^\.\//, "");
  return cleaned.length > 0 ? cleaned : ".";
}

function stableValue(value: unknown, root: string, key?: string): unknown {
  if (typeof value === "string" && key !== undefined && PATH_KEYS.has(key)) {
    return normalizeToolPath(value, root);
  }
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry, root));
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      sorted[entryKey] = stableValue(entryValue, root, entryKey);
    }
    return sorted;
  }
  return value;
}

/** Stable JSON for an argument object, with path keys normalized. */
export function stableToolArguments(args: Record<string, unknown>, root: string): string {
  return JSON.stringify(stableValue(args, root));
}

export function toolCallSignature(
  name: string,
  args: Record<string, unknown>,
  root: string,
): string {
  return `${name}\u0000${stableToolArguments(args, root)}`;
}

export interface ToolCallState {
  signature: string;
  name: string;
  count: number;
  consecutive: number;
  previousCallId?: string;
  repeated: boolean;
}

/** Counts identical tool calls inside one turn. A new turn starts fresh. */
export class ToolCallTracker {
  private readonly counts = new Map<string, number>();
  private readonly lastCallIds = new Map<string, string>();
  private lastSignature: string | undefined;
  private consecutive = 0;

  constructor(private readonly maxRepeated: number) {}

  record(signature: string, name: string, callId: string): ToolCallState {
    const count = (this.counts.get(signature) ?? 0) + 1;
    this.counts.set(signature, count);
    const previousCallId = this.lastCallIds.get(signature);
    this.lastCallIds.set(signature, callId);
    if (signature === this.lastSignature) {
      this.consecutive += 1;
    } else {
      this.lastSignature = signature;
      this.consecutive = 1;
    }
    return {
      signature,
      name,
      count,
      consecutive: this.consecutive,
      previousCallId,
      repeated: this.maxRepeated > 0 && count > this.maxRepeated,
    };
  }

  count(signature: string): number {
    return this.counts.get(signature) ?? 0;
  }

  /** A changed file makes the next read of that range a fresh call. */
  resetSignature(signature: string): void {
    this.counts.delete(signature);
    this.lastCallIds.delete(signature);
  }

  reset(): void {
    this.counts.clear();
    this.lastCallIds.clear();
    this.lastSignature = undefined;
    this.consecutive = 0;
  }
}

interface ReadFileEntry {
  mtimeMs: number;
  size: number;
  hash: string;
}

async function fingerprint(path: string): Promise<ReadFileEntry> {
  const info = await stat(path);
  const sample = await Bun.file(path).slice(0, 4_096).arrayBuffer();
  const hash = createHash("sha1").update(Buffer.from(sample)).digest("hex").slice(0, 16);
  return { mtimeMs: info.mtimeMs, size: info.size, hash };
}

/**
 * Remembers reads of the same range in one turn. The cache is validated with
 * mtime, size, and a short hash of the first 4 KiB, so a write that keeps the
 * same size is still detected.
 */
export class ReadFileCache {
  private readonly entries = new Map<string, ReadFileEntry>();

  private key(filePath: string, offset: number, limit: number, root: string): string {
    return `${normalizeToolPath(filePath, root)}\u0000${offset}\u0000${limit}`;
  }

  async unchanged(
    filePath: string,
    offset: number,
    limit: number,
    root: string,
  ): Promise<boolean> {
    const entry = this.entries.get(this.key(filePath, offset, limit, root));
    if (!entry) return false;
    try {
      const current = await fingerprint(resolve(root, filePath));
      return (
        current.mtimeMs === entry.mtimeMs &&
        current.size === entry.size &&
        current.hash === entry.hash
      );
    } catch {
      return false;
    }
  }

  async remember(filePath: string, offset: number, limit: number, root: string): Promise<void> {
    try {
      const current = await fingerprint(resolve(root, filePath));
      this.entries.set(this.key(filePath, offset, limit, root), current);
    } catch {
      // A missing or unreadable file is simply not cached.
    }
  }

  reset(): void {
    this.entries.clear();
  }
}
