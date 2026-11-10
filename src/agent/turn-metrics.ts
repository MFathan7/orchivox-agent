import type { ProviderTiming, StreamEvent, TurnCompaction, TurnMetrics, Usage } from "../types/schema";

export interface TurnMetricsSnapshotInput {
  usage?: Usage;
  finishReason?: string;
  stepLimit?: number;
  toolLimit?: number;
  timeLimitMs?: number;
  workers?: TurnMetrics["workers"];
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
  private readonly startedAt: number;
  private readonly providerTimings: ProviderTiming[] = [];
  private currentProvider?: ProviderTiming;
  private firstResponseMs?: number;
  private firstTextMs?: number;
  private toolDurationMs = 0;
  private workerWaitMs = 0;
  private workerToolsAvailable?: boolean;
  private coordinatorAvailable?: boolean;
  private steps = 0;
  private toolCalls = 0;
  private readonly toolCounts = new Map<string, number>();
  private repeatedCalls = 0;
  private progressCheckpoints = 0;
  private compactions = 0;
  private lastCompaction?: TurnCompaction;
  private prunes = 0;

  constructor(private readonly now: () => number = Date.now) { this.startedAt = now(); }

  startProvider(provider?: string, model?: string, reasoningEffort?: string): void {
    const timing: ProviderTiming = { provider, model, reasoning_effort: reasoningEffort, started_ms: this.elapsedMs(), duration_ms: 0, retries: 0, retry_delay_ms: 0, prompt_tokens: 0, cache_read_tokens: 0 };
    this.providerTimings.push(timing);
    this.currentProvider = timing;
  }

  toolAvailability(names: string[]): void {
    this.workerToolsAvailable = names.includes("spawn_subagents");
    this.coordinatorAvailable = names.includes("coordinate");
  }

  providerEvent(event: StreamEvent): void {
    const timing = this.currentProvider;
    if (!timing) return;
    const elapsed = this.elapsedMs();
    if (event.type === "token" || event.type === "thinking_token" || event.type === "tool_call_delta" || event.type === "tool_call_ready") {
      timing.first_event_ms ??= elapsed - timing.started_ms;
      this.firstResponseMs ??= elapsed;
    }
    if (event.type === "token" && event.text.length > 0) {
      timing.first_text_ms ??= elapsed - timing.started_ms;
      this.firstTextMs ??= elapsed;
    }
    if (event.type === "retry_scheduled") { timing.retries += 1; timing.retry_delay_ms += event.delay_ms; }
    if (event.type === "usage") { timing.prompt_tokens += event.prompt_tokens; timing.cache_read_tokens += event.cache_read_input_tokens; }
  }

  finishProvider(): void {
    if (this.currentProvider) this.currentProvider.duration_ms = this.elapsedMs() - this.currentProvider.started_ms;
    this.currentProvider = undefined;
  }

  recordToolEnd(name: string, durationMs: number): void {
    this.toolDurationMs += durationMs;
    if (name === "task_wait") this.workerWaitMs += durationMs;
  }

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

  recordCheckpoint(): void {
    this.progressCheckpoints += 1;
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
    return this.now() - this.startedAt;
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
      progress_checkpoints: this.progressCheckpoints,
      duration_ms: this.elapsedMs(),
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
      first_response_ms: this.firstResponseMs,
      first_text_ms: this.firstTextMs,
      provider_timings: this.providerTimings.map((timing) => ({ ...timing })),
      tool_duration_ms: this.toolDurationMs,
      worker_wait_ms: this.workerWaitMs,
      worker_tools_available: this.workerToolsAvailable,
      coordinator_available: this.coordinatorAvailable,
      workers: input.workers,
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
    `  Checkpoints  : ${metrics.progress_checkpoints ?? 0}`,
    `  Wall time    : ${formatDuration(metrics.duration_ms)}`,
    `  Time limit   : ${metrics.time_limit_ms !== undefined ? formatDuration(metrics.time_limit_ms) : "none"}`,
    `  Tokens       : ${formatCount(metrics.total_tokens)} (prompt ${formatCount(metrics.prompt_tokens)}, completion ${formatCount(metrics.completion_tokens)})`,
    `  Compactions  : ${metrics.compactions}`,
    `  Pruned       : ${metrics.prunes}`,
    `  Finish       : ${metrics.finish_reason ?? "unknown"}`,
  ];
  if (metrics.provider_timings) {
    const timings = metrics.provider_timings;
    const ms = (value: number | undefined) => value === undefined ? "not observed" : `${Math.round(value)}ms`;
    lines.push(
      `  First event  : ${ms(metrics.first_response_ms)} (text, reasoning, or tool call)`,
      `  First text   : ${ms(metrics.first_text_ms)}`,
      `  Provider     : ${timings.length} request(s), ${ms(timings.reduce((sum, timing) => sum + timing.duration_ms, 0))}`,
      `  Tool time    : ${ms(metrics.tool_duration_ms)} summed; parallel calls overlap`,
      `  Worker wait  : ${ms(metrics.worker_wait_ms)}`,
      `  Delegation   : ${metrics.workers?.length ?? 0} worker(s); ${metrics.tool_counts.coordinate ?? 0} coordinator call(s)`,
      `  Worker tools : ${metrics.worker_tools_available ? "available" : "not available"}; coordinator ${metrics.coordinator_available ? "available" : "not available"}`,
    );
    for (const [index, timing] of timings.entries()) lines.push(`    ${index + 1}. ${timing.provider ?? "provider"}/${timing.model ?? "model"}: reasoning=${timing.reasoning_effort ?? "default"}, ${ms(timing.duration_ms)}, first event ${ms(timing.first_event_ms)}, retries ${timing.retries} (${ms(timing.retry_delay_ms)}), cache ${timing.cache_read_tokens}/${timing.prompt_tokens} input tokens`);
    for (const worker of metrics.workers ?? []) lines.push(`    ${worker.id} [${worker.state}]: queue ${ms(worker.queue_ms)}, elapsed ${ms(worker.duration_ms)}`);
  }
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
