import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Output budget for tool results.
 *
 * A single oversized tool result is what pushes a session past the model's
 * context window, and compaction cannot shrink one message. Tools therefore
 * cap what they hand to the model and say how to get the rest.
 */
export const DEFAULT_MAX_LINES = 2_000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface OutputBudget {
  maxLines: number;
  maxBytes: number;
}

export interface TruncationResult {
  /** Text to hand to the model, notice included. */
  text: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  keptLines: number;
  keptBytes: number;
}

export interface TruncateOptions {
  maxLines?: number;
  maxBytes?: number;
  /** Extra line appended after the notice, such as the spill file path. */
  detail?: string;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function notice(
  result: Omit<TruncationResult, "text">,
  direction: "first" | "last",
  options: TruncateOptions,
): string {
  const scope =
    result.keptLines === result.totalLines
      ? `${formatSize(result.keptBytes)} of ${formatSize(result.totalBytes)}`
      : `the ${direction} ${result.keptLines} of ${result.totalLines} lines, ${formatSize(result.keptBytes)} of ${formatSize(result.totalBytes)}`;
  const hint =
    direction === "first"
      ? "Narrow the request with offset, limit, a pattern, or a smaller path."
      : "Re-run the command with a filter to see the rest.";
  const detail = options.detail ? ` ${options.detail}` : "";
  return `[Output truncated: showing ${scope}. ${hint}${detail}]`;
}

function sliceFirstLine(lines: string[], maxBytes: number): string {
  const first = lines[0] ?? "";
  let sliced = first.slice(0, Math.max(0, maxBytes));
  if (/[\uD800-\uDBFF]$/.test(sliced)) sliced = sliced.slice(0, -1);
  return sliced;
}

/** Keeps the beginning of the output, for reads, searches, and pages. */
export function truncateHead(text: string, options: TruncateOptions = {}): TruncationResult {
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES);
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const lines = text.split("\n");
  const totalLines = lines.length;
  const totalBytes = byteLength(text);
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      text,
      truncated: false,
      totalLines,
      totalBytes,
      keptLines: totalLines,
      keptBytes: totalBytes,
    };
  }

  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (kept.length >= maxLines) break;
    const cost = byteLength(line) + (kept.length > 0 ? 1 : 0);
    if (bytes + cost > maxBytes) break;
    kept.push(line);
    bytes += cost;
  }
  if (kept.length === 0) {
    const only = sliceFirstLine(lines, maxBytes);
    kept.push(only);
    bytes = byteLength(only);
  }

  const base = {
    truncated: true,
    totalLines,
    totalBytes,
    keptLines: kept.length,
    keptBytes: bytes,
  };
  return { ...base, text: `${kept.join("\n")}\n\n${notice(base, "first", options)}` };
}

/** Keeps the end of the output, for commands where errors land last. */
export function truncateTail(text: string, options: TruncateOptions = {}): TruncationResult {
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES);
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const lines = text.split("\n");
  const totalLines = lines.length;
  const totalBytes = byteLength(text);
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      text,
      truncated: false,
      totalLines,
      totalBytes,
      keptLines: totalLines,
      keptBytes: totalBytes,
    };
  }

  const kept: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (kept.length >= maxLines) break;
    const line = lines[index] ?? "";
    const cost = byteLength(line) + (kept.length > 0 ? 1 : 0);
    if (bytes + cost > maxBytes) break;
    kept.unshift(line);
    bytes += cost;
  }
  if (kept.length === 0) {
    const line = lines[lines.length - 1] ?? "";
    const only = line.slice(-maxBytes);
    kept.push(only);
    bytes = byteLength(only);
  }

  const base = {
    truncated: true,
    totalLines,
    totalBytes,
    keptLines: kept.length,
    keptBytes: bytes,
  };
  return { ...base, text: `${notice(base, "last", options)}\n${kept.join("\n")}` };
}

/**
 * Writes the full tool output to the cache directory so the model gets a path
 * it can read later instead of the whole payload inline.
 */
export async function spillToolOutput(text: string, label = "output"): Promise<string | undefined> {
  try {
    const base = globalThis.process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
    const directory = join(base, "orchivox", "tool-output");
    await mkdir(directory, { recursive: true });
    const safeLabel = label.replace(/[^a-z0-9_-]/gi, "-").slice(0, 24) || "output";
    const file = join(directory, `${Date.now()}-${safeLabel}-${crypto.randomUUID().slice(0, 8)}.log`);
    await Bun.write(file, text);
    return file;
  } catch {
    return undefined;
  }
}
