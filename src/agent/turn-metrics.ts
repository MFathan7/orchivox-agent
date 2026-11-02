import type { TurnCompaction, TurnMetrics, Usage } from "../types/schema";

export interface TurnMetricsSnapshotInput {
  usage?: Usage;
  finishReason?: string;
  stepLimit?: number;
  toolLimit?: number;
  timeLimitMs?: number;
}

export interface TurnBudgetLimits {
  stepLimit: number;
  toolLimit: number;
  timeLimitMs: number;
}

export interface TurnBudgetWarning {
  reason: "step" | "tool" | "time";
  used: number;
  limit: number;
}

/** True once the wall clock budget is spent. 0 means unlimited. */
export function timeBudgetReached(elapsedMs: number, limitMs: number): boolean {
  return limitMs > 0 && elapsedMs >= limitMs;
}

/**
 * Returns the first budget that is close to its limit. The warning fires once
 * before the limit is reached, never after.
 */
export function turnBudgetWarning(input: {
  steps: number;
  toolCalls: number;
  elapsedMs: number;
  limits: TurnBudgetLimits;
}): TurnBudgetWarning | undefined {
  const { steps, toolCalls, elapsedMs, limits } = input;
  if (limits.timeLimitMs > 0) {
    if (elapsedMs < limits.timeLimitMs && elapsedMs >= limits.timeLimitMs * 0.8) {
      return { reason: "time", used: elapsedMs, limit: limits.timeLimitMs };
    }
  }
  if (limits.toolLimit > 0) {
    const threshold = Math.ceil(limits.toolLimit * 0.8);
    if (toolCalls < limits.toolLimit && toolCalls >= threshold) {
      return { reason: "tool", used: toolCalls, limit: limits.toolLimit };
    }
  }
  if (limits.stepLimit > 0) {
    const threshold = Math.ceil(limits.stepLimit * 0.8);
    if (steps < limits.stepLimit && steps >= threshold) {
      return { reason: "step", used: steps, limit: limits.stepLimit };
    }
  }
  return undefined;
}

/** Counts one turn. A new turn starts with a fresh tracker. */
export class TurnMetricsTracker {
  private readonly startedAt = Date.now();
  private steps = 0;
  private toolCalls = 0;
  private readonly toolCounts = new Map<string, number>();
  private repeatedCalls = 0;
  private compactions = 0;
  private lastCompaction?: TurnCompaction;
  private prunes = 0;

  recordStep(): void {
    this.steps += 1;
  }

  recordTool(name: string): void {
    this.toolCalls += 1;
    this.toolCounts.set(name, (this.toolCounts.get(name) ?? 0) + 1);
  }

  recordRepeatedCall(): void {
    this.repeatedCalls += 1;
  }

  recordCompaction(compaction?: TurnCompaction): void {
    this.compactions += 1;
    if (compaction) this.lastCompaction = compaction;
  }

  recordPrune(): void {
    this.prunes += 1;
  }

  get stepCount(): number {
    return this.steps;
  }

  get toolCallCount(): number {
    return this.toolCalls;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  snapshot(input: TurnMetricsSnapshotInput = {}): TurnMetrics {
    const promptTokens = input.usage?.prompt_tokens ?? 0;
    const completionTokens = input.usage?.completion_tokens ?? 0;
    return {
      steps: this.steps,
      tool_calls: this.toolCalls,
      tool_counts: Object.fromEntries(
        [...this.toolCounts.entries()].sort((left, right) => right[1] - left[1]),
      ),
      repeated_calls: this.repeatedCalls,
      duration_ms: Date.now() - this.startedAt,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      compactions: this.compactions,
      ...(this.lastCompaction ? { last_compaction: this.lastCompaction } : {}),
      prunes: this.prunes,
      ...(input.stepLimit ? { step_limit: input.stepLimit } : {}),
      ...(input.toolLimit ? { tool_limit: input.toolLimit } : {}),
      ...(input.timeLimitMs ? { time_limit_ms: input.timeLimitMs } : {}),
      ...(input.finishReason ? { finish_reason: input.finishReason } : {}),
    };
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
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

/** Plain text for /turn-report and /stats. */
export function formatTurnMetrics(metrics: TurnMetrics): string {
  const steps =
    metrics.step_limit !== undefined
      ? `${metrics.steps}/${metrics.step_limit}`
      : `${metrics.steps}`;
  const tools =
    metrics.tool_limit !== undefined
      ? `${metrics.tool_calls}/${metrics.tool_limit}`
      : `${metrics.tool_calls}`;
  const lines = [
    "Turn report:",
    `  Steps        : ${steps}`,
    `  Tool calls   : ${tools}`,
    `  Repeated     : ${metrics.repeated_calls}`,
    `  Wall time    : ${formatDuration(metrics.duration_ms)}`,
    `  Time limit   : ${metrics.time_limit_ms !== undefined ? formatDuration(metrics.time_limit_ms) : "none"}`,
    `  Tokens       : ${formatCount(metrics.total_tokens)} (prompt ${formatCount(metrics.prompt_tokens)}, completion ${formatCount(metrics.completion_tokens)})`,
    `  Compactions  : ${metrics.compactions}`,
    `  Pruned       : ${metrics.prunes}`,
    `  Finish       : ${metrics.finish_reason ?? "unknown"}`,
  ];
  if (metrics.last_compaction) {
    const last = metrics.last_compaction;
    const request =
      last.request_bytes !== undefined
        ? ` · request ${formatBytes(last.request_bytes)}${
            last.max_request_bytes ? `/${formatBytes(last.max_request_bytes)}` : ""
          }`
        : "";
    const budget =
      last.input_budget !== undefined
        ? ` · budget ${formatCount(last.input_budget)}`
        : "";
    lines.push(
      `  Compaction   : ${last.trigger} · ${formatCount(last.before_tokens)} -> ${formatCount(
        last.after_tokens,
      )} tokens${request}${budget}`,
    );
  }
  const counts = Object.entries(metrics.tool_counts);
  if (counts.length > 0) {
    lines.push("  Tools        :");
    for (const [name, count] of counts.slice(0, 12)) {
      lines.push(`    ${name}: ${count}`);
    }
    if (counts.length > 12) lines.push(`    ... ${counts.length - 12} more`);
  }
  return lines.join("\n");
}
