import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface UsageLogEntry {
  at: number;
  session_id?: string;
  mode: string;
  model?: string;
  turn: number;
  prompt_estimate: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  context_window: number;
  input_budget: number;
  compacted: boolean;
  pruned_tokens: number;
  provider_reported: boolean;
}

export function usageLogPath(): string {
  const cacheHome = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(cacheHome, "orchivox", "usage.log");
}

export function usageLogEnabled(): boolean {
  const value = process.env.ORCHIVOX_USAGE_LOG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** Appends one JSON line per provider request. Logging never breaks a turn. */
export async function appendUsageLog(
  entry: UsageLogEntry,
  path: string = usageLogPath(),
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Usage logging is best effort.
  }
}
