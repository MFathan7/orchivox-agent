export interface SessionSizeWarning {
  totalTokens?: number;
  historyBytes: number;
  warnTokens?: number;
  warnBytes?: number;
}

export function shouldWarnLargeSession(input: SessionSizeWarning): boolean {
  const tokens = input.warnTokens ?? 0;
  const bytes = input.warnBytes ?? 0;
  const tokensExceeded = tokens > 0 && (input.totalTokens ?? 0) >= tokens;
  const bytesExceeded = bytes > 0 && input.historyBytes >= bytes;
  return tokensExceeded || bytesExceeded;
}
