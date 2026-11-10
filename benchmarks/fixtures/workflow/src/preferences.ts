export function pageSize(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.min(100, Math.max(10, Math.trunc(value)));
}
