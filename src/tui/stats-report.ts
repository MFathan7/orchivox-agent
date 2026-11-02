import type { TurnMetrics } from "../types/schema";
import {
  formatBytes,
  formatContextUsage,
  formatContextWindow,
  formatCost,
  formatTokenCount,
  formatTurnUsage,
} from "./format";

export interface StatsReportInput {
  sessionId?: string;
  messageCount: number;
  totalTokens: number;
  lastPromptTokens: number;
  lastEstimatedPromptTokens: number;
  lastCompletionTokens: number;
  lastTotalTokens: number;
  lastOutcome?: string;
  turnMetrics?: TurnMetrics;
  sessionCostUsd: number;
  allSessionsCostUsd: number;
  mode: string;
  modeModel?: string;
  contextTokens: number;
  contextWindow?: number;
  contextSource: string;
  requestBytes: number;
  maxRequestBytes: number;
  inputBudget: number;
  bufferTokens: number;
  prune: boolean;
  pruneProtectTokens?: number;
  pruneMinTokens?: number;
  turnPromptTokens: number;
  turnCompletionTokens: number;
  turnTotalTokens: number;
  inputLimit?: number;
  inputSource: string;
  outputLimit?: number;
  outputSource: string;
  reasoningEffort: string;
  themeLabel: string;
  mcpLabel: string;
  pluginLabel: string;
  skillCount: number;
  activeSkills: string[];
  taskSummary: { completed: number; total: number; running: number; blocked: number };
  branch: string;
  snapshotCount: number;
  sessionCount: number;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function tokenAmount(tokens: number): string {
  return tokens > 0 ? `${formatTokenCount(tokens, false)} tokens` : "not measured yet";
}

/** The text behind `/stats`, split out so the panel can be checked without a TUI. */
export function formatStatsReport(input: StatsReportInput): string {
  const metrics = input.turnMetrics;
  const steps = metrics
    ? `${metrics.steps}${metrics.step_limit !== undefined ? `/${metrics.step_limit}` : ""}`
    : "none";
  const tools = metrics
    ? `${metrics.tool_calls}${metrics.tool_limit !== undefined ? `/${metrics.tool_limit}` : ""}`
    : "none";
  return [
    "Session Statistics:",
    "",
    "Session Totals:",
    `  Active Session ID : ${input.sessionId ?? "(draft)"}`,
    `  Messages          : ${input.messageCount} messages`,
    `  Total Tokens      : ${formatTokenCount(input.totalTokens, false)} tokens`,
    `  Session Spent     : ${formatCost(input.sessionCostUsd)} (estimated)`,
    `  All Sessions Spent: ${formatCost(input.allSessionsCostUsd)} (estimated)`,
    `  VCS Snapshots     : ${input.snapshotCount} snapshots recorded`,
    "  Note              : Session spend accumulates and survives compaction.",
    "",
    "Current Context:",
    `  Window            : ${formatContextWindow(input.contextWindow)} (${input.contextSource})`,
    `  Used              : ${formatContextUsage(input.contextTokens, input.contextWindow)}`,
    `  Input Limit       : ${
      input.inputLimit
        ? `${formatContextWindow(input.inputLimit)} (${input.inputSource})`
        : "follows context"
    }`,
    `  Output Limit      : ${formatContextWindow(input.outputLimit)} (${input.outputSource})`,
    `  Context Buffer    : ${tokenAmount(input.bufferTokens)}`,
    `  Input Budget      : ${tokenAmount(input.inputBudget)}`,
    `  Compaction At     : ${tokenAmount(input.inputBudget)}`,
    `  Prune             : ${input.prune ? "on" : "off"}${
      input.pruneProtectTokens !== undefined && input.pruneMinTokens !== undefined
        ? ` (protect ${formatTokenCount(input.pruneProtectTokens)} · min ${formatTokenCount(
            input.pruneMinTokens,
          )})`
        : ""
    }`,
    "",
    "Request:",
    `  Estimated Bytes   : ${
      input.requestBytes > 0 ? formatBytes(input.requestBytes) : "not measured yet"
    }`,
    `  Explicit Cap      : ${
      input.maxRequestBytes > 0 ? formatBytes(input.maxRequestBytes) : "disabled"
    }`,
    `  Local Estimate    : ${formatTokenCount(input.lastEstimatedPromptTokens, false)} tokens`,
    `  Last Prompt       : ${formatTokenCount(input.lastPromptTokens, false)} provider / ${formatTokenCount(input.lastEstimatedPromptTokens, false)} estimated`,
    `  Last Completion   : ${formatTokenCount(input.lastCompletionTokens, false)}`,
    `  Last Request      : ${formatTokenCount(input.lastTotalTokens, false)}`,
    "",
    "Last Turn:",
    `  Outcome           : ${input.lastOutcome ?? "unknown"}`,
    `  Steps             : ${steps}`,
    `  Tools             : ${tools}`,
    `  Repeated          : ${metrics?.repeated_calls ?? 0}`,
    `  Wall Time         : ${metrics ? formatDuration(metrics.duration_ms) : "none"}`,
    `  Finish            : ${metrics?.finish_reason ?? "none"}`,
    `  Turn Usage        : ${formatTurnUsage({
      promptTokens: input.turnPromptTokens,
      completionTokens: input.turnCompletionTokens,
      totalTokens: input.turnTotalTokens,
    })}`,
    "",
    "Agent:",
    `  Mode              : ${input.mode}`,
    `  Model             : ${input.modeModel ?? "not configured"}`,
    `  Reasoning         : ${input.reasoningEffort}`,
    `  Theme             : ${input.themeLabel}`,
    `  Connected MCP     : ${input.mcpLabel}`,
    `  Loaded Plugins    : ${input.pluginLabel}`,
    `  Skills Installed  : ${input.skillCount}`,
    `  Session Skills    : ${input.activeSkills.length > 0 ? input.activeSkills.join(", ") : "none"}`,
    `  Task Board        : ${input.taskSummary.completed}/${input.taskSummary.total} completed, ${input.taskSummary.running} running, ${input.taskSummary.blocked} blocked`,
    "",
    "Workspace:",
    `  Git Branch        : ${input.branch}`,
    `  Saved Sessions    : ${input.sessionCount} total sessions in database`,
  ].join("\n");
}
