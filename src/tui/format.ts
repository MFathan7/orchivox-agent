import { displayWidth } from "./text-wrap";

export interface DisplaySegment {
  key: string;
  text: string;
  dropOrder: number;
}

/**
 * Chooses the segments that fit. The highest dropOrder (100 and above) is
 * pinned; lower values drop first until the measured line fits.
 */
export function fitSegments(segments: DisplaySegment[], width: number): Set<string> {
  const selected = new Set(segments.map((segment) => segment.key));
  const totalWidth = (): number =>
    segments
      .filter((segment) => selected.has(segment.key))
      .reduce((sum, segment) => sum + displayWidth(segment.text), 0);
  while (totalWidth() > width) {
    const drop = segments
      .filter((segment) => selected.has(segment.key) && segment.dropOrder < 100)
      .sort((left, right) => left.dropOrder - right.dropOrder)[0];
    if (!drop) break;
    selected.delete(drop.key);
  }
  return selected;
}

export function formatTokenCount(count: number, compact = true): string {
  const safe = Math.max(0, Math.round(count));
  if (!compact) return safe.toLocaleString("en-US");
  if (safe < 1_000) return String(safe);
  if (safe < 1_000_000) {
    const value = safe / 1_000;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const value = safe / 1_000_000;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")}M`;
}

function formatContextTokenCount(count: number): string {
  const safe = Math.max(0, Math.round(count));
  if (safe < 1_000) return String(safe);
  if (safe < 1_000_000) {
    return `${(safe / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return `${(safe / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatContextWindow(tokens?: number): string {
  return tokens && tokens > 0 ? formatContextTokenCount(tokens) : "unknown";
}

export function contextUsagePercent(used = 0, window?: number): number | undefined {
  if (!window || window <= 0) return undefined;
  return Math.min(100, Math.round((Math.max(0, used) / window) * 100));
}

export function formatContextUsage(used = 0, window?: number): string {
  const tokenText = formatContextTokenCount(used);
  const percent = contextUsagePercent(used, window);
  if (percent === undefined) return tokenText;
  return `${tokenText} / ${formatContextTokenCount(window ?? 0)} (${percent}%)`;
}

export function formatCost(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return "$0.0000";
  if (costUsd < 0.0001) return "<$0.0001";
  return `$${costUsd.toFixed(4)}`;
}

/** One line for the token cost of a single user turn. */
export function formatTurnUsage(input: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}): string {
  const prompt = formatTokenCount(Math.max(0, input.promptTokens));
  const completion = formatTokenCount(Math.max(0, input.completionTokens));
  const total = formatTokenCount(Math.max(0, input.totalTokens));
  return `${prompt} prompt + ${completion} completion = ${total}`;
}

/** One line for the live turn status: what the agent is doing and for how long. */
export function formatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function formatTurnStatus(input: {
  answering: boolean;
  elapsedSeconds: number;
  completedTools: number;
  runningLabel?: string;
  runningSeconds?: number;
  step?: number;
  stepLimit?: number;
  toolLimit?: number;
  timeLimitSeconds?: number;
  contextPercent?: number;
  requestLabel?: string;
  /** Available columns. Extra segments are dropped when space is tight. */
  width?: number;
}): string {
  const segments: Array<{ text: string; priority: number }> = [];
  if (input.step !== undefined && input.step > 1) {
    segments.push({
      text:
        input.stepLimit !== undefined
          ? `Step ${input.step}/${input.stepLimit}`
          : `Step ${input.step}`,
      priority: 5,
    });
  }
  segments.push({
    text: input.runningLabel ? input.runningLabel : input.answering ? "Answering" : "Thinking",
    priority: 4,
  });
  const seconds = Math.max(
    0,
    Math.floor(input.runningLabel ? (input.runningSeconds ?? 0) : input.elapsedSeconds),
  );
  if (seconds > 0) {
    segments.push({
      text:
        input.timeLimitSeconds !== undefined && !input.runningLabel
          ? `${formatElapsed(seconds)}/${formatElapsed(input.timeLimitSeconds)}`
          : formatElapsed(seconds),
      priority: 2,
    });
  }
  const tools = Math.max(0, Math.floor(input.completedTools));
  if (tools > 0) {
    segments.push({
      text:
        input.toolLimit !== undefined
          ? `${tools}/${input.toolLimit} ${tools === 1 && input.toolLimit === 1 ? "tool" : "tools"}`
          : `${tools} ${tools === 1 ? "tool" : "tools"}`,
      priority: 3,
    });
  }
  if (input.contextPercent !== undefined) {
    segments.push({ text: `ctx ${input.contextPercent}%`, priority: 1 });
  }
  if (input.requestLabel) {
    segments.push({ text: `req ${input.requestLabel}`, priority: 0 });
  }

  // Drop the lowest-priority segment until the line fits. The caller owns the
  // spinner and hint columns, so this width is already the text budget.
  if (input.width !== undefined) {
    while (
      segments.length > 1 &&
      displayWidth(segments.map((segment) => segment.text).join(" · ")) > input.width
    ) {
      const lowest = Math.min(...segments.map((segment) => segment.priority));
      const index = segments.findIndex((segment) => segment.priority === lowest);
      segments.splice(index, 1);
    }
  }

  if (segments.length === 0) {
    segments.push({ text: input.answering ? "Answering" : "Thinking", priority: 4 });
  }
  return segments.map((segment) => segment.text).join(" · ");
}

export function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return text.slice(0, maxWidth);
  return `${text.slice(0, maxWidth - 3)}...`;
}

export interface SubagentSummary {
  active: number;
  running: number;
  queued: number;
  failed: number;
}

export function summarizeSubagents(
  workers: ReadonlyArray<{ status: string }>,
): SubagentSummary {
  let running = 0;
  let queued = 0;
  let failed = 0;
  for (const worker of workers) {
    switch (worker.status) {
      case "queued":
        queued += 1;
        break;
      case "preparing":
      case "running":
      case "finalizing":
        running += 1;
        break;
      case "failed":
      case "timed_out":
        failed += 1;
        break;
      default:
        break;
    }
  }
  return { active: running + queued, running, queued, failed };
}

export function subagentStatusText(summary: SubagentSummary, width: number): string {
  if (summary.active <= 0) return "";
  const parts: string[] = [];
  if (summary.running > 0) parts.push(`${summary.running} running`);
  if (summary.queued > 0) parts.push(`${summary.queued} queued`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  const base = `Agents ${parts.join(" · ")}`;
  if (width >= 90) return `${base} · /hub details`;
  if (width >= 40) return base;
  return `Agents ${summary.active}`;
}
