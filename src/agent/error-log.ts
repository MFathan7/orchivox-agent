import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ErrorLogEntry {
  at: number;
  session_id?: string;
  mode?: string;
  model?: string;
  finish_reason: string;
  message: string;
  turn_tokens?: number;
}

export function errorLogPath(): string {
  const cacheHome = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(cacheHome, "orchivox", "errors.log");
}

/** Records why a turn ended badly. This log is always on; usage logging stays opt-in. */
export async function appendErrorLog(
  entry: ErrorLogEntry,
  path: string = errorLogPath(),
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Logging must never break a turn.
  }
}
