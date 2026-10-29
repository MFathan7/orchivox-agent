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
export function formatTurnStatus(input: {
  answering: boolean;
  elapsedSeconds: number;
  completedTools: number;
  runningLabel?: string;
  runningSeconds?: number;
  step?: number;
}): string {
  const parts: string[] = [];
  if (input.step !== undefined && input.step > 1) parts.push(`Step ${input.step}`);
  parts.push(
    input.runningLabel
      ? input.runningLabel
      : input.answering
        ? "Answering"
        : "Thinking",
  );
  const seconds = Math.max(
    0,
    Math.floor(input.runningLabel ? (input.runningSeconds ?? 0) : input.elapsedSeconds),
  );
  if (seconds > 0) parts.push(`${seconds}s`);
  const tools = Math.max(0, Math.floor(input.completedTools));
  if (tools > 0) parts.push(`${tools} ${tools === 1 ? "tool" : "tools"}`);
  return parts.join(" · ");
}

export function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return text.slice(0, maxWidth);
  return `${text.slice(0, maxWidth - 3)}...`;
}
