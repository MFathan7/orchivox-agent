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

export function formatCost(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return "$0.0000";
  if (costUsd < 0.0001) return "<$0.0001";
  return `$${costUsd.toFixed(4)}`;
}
