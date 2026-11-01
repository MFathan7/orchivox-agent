export interface CleanupResult {
  removed: number;
  freedBytes: number;
}

export function addCleanupResults(
  total: CleanupResult,
  next: CleanupResult,
): CleanupResult {
  return {
    removed: total.removed + next.removed,
    freedBytes: total.freedBytes + next.freedBytes,
  };
}
