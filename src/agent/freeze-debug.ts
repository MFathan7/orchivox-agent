import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

let enabled: boolean | undefined;

export function freezeDebugEnabled(): boolean {
  if (enabled === undefined) {
    enabled = process.env.ORCHIVOX_FREEZE_DEBUG === "1";
  }
  return enabled;
}

export function freezeLogPath(): string {
  const cacheHome = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(cacheHome, "orchivox", "freeze.log");
}

/** Best-effort freeze log. Enabled only with ORCHIVOX_FREEZE_DEBUG=1. */
export function logFreeze(kind: string, data: Record<string, unknown> = {}): void {
  if (!freezeDebugEnabled()) return;
  const path = freezeLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      if (statSync(path).size > 5_000_000) writeFileSync(path, "", "utf8");
    } catch {
      // The file does not exist yet.
    }
    appendFileSync(path, `${JSON.stringify({ at: Date.now(), kind, ...data })}\n`, "utf8");
  } catch {
    // Debug logging must never break the TUI.
  }
}

/**
 * Logs event loop lag only when it is large enough to explain a frozen frame.
 * The monitor itself is enabled only in freeze debug mode.
 */
export function startEventLoopMonitor(): () => void {
  if (!freezeDebugEnabled()) return () => undefined;
  const monitor = monitorEventLoopDelay({ resolution: 20 });
  monitor.enable();
  const timer = setInterval(() => {
    const max = monitor.max / 1e6;
    const mean = monitor.mean / 1e6;
    const p99 = monitor.percentile(99) / 1e6;
    monitor.reset();
    if (max >= 200) {
      logFreeze("event_loop", {
        max_ms: Math.round(max),
        mean_ms: Math.round(mean),
        p99_ms: Math.round(p99),
      });
    }
  }, 1_000);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    monitor.disable();
  };
}
