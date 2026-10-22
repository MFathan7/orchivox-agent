/**
 * Provider retry policy for transient failures.
 *
 * Request-shape problems (unsupported parameters, context overflow) are handled
 * separately: they are deterministic, so retrying the same request is useless.
 * This module covers transport and provider-side failures: network drops,
 * 408/409/429, 5xx, gateway errors, and streams that end early.
 */

export interface RetryPolicy {
  enabled: boolean;
  /** Retries after the first attempt. 0 disables retries. */
  maxRetries: number;
  /** Per-attempt delay is baseDelayMs * 2^(attempt-1) before jitter. */
  baseDelayMs: number;
  /** Cap for the local exponential delay. */
  maxDelayMs: number;
  /** A server requested delay above this fails fast instead of sleeping. */
  maxRetryAfterMs: number;
}

export const DEFAULT_PROVIDER_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 60_000,
};

/** Time allowed for the provider to answer with response headers. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Longest silence tolerated while the response body is streaming. */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

const NON_RETRYABLE_PATTERNS = [
  /insufficient_quota/i,
  /quota exceeded/i,
  /out of budget/i,
  /\bbilling\b/i,
  /usage limit reached/i,
  /available balance/i,
  /subscription[_\s-]?(?:sharing[_\s-]?)?usage[_\s-]?(?:limit|unavailable)/i,
  /invalid[_ ]api[_ ]key/i,
  /incorrect api key/i,
  /unauthorized/i,
  /authentication/i,
  /permission denied/i,
  /model[_\s-]?not[_\s-]?found/i,
  /does not exist/i,
];

const RETRYABLE_PATTERNS = [
  /\boverloaded\b/i,
  /server[_\s-]?busy/i,
  /high demand/i,
  /at capacity/i,
  /rate.?limit/i,
  /too many requests/i,
  // Status codes must not be part of a longer word or number.
  /(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])/,
  /service.?(?:is.?)?(?:temporarily.?)?unavailable/i,
  /server.?error/i,
  /internal.?error/i,
  /provider.?returned.?(?:an.?)?error/i,
  /upstream.?(?:request.?(?:failed|error)|connect|error)/i,
  /unable to forward upstream/i,
  /stream[_\s-]?(?:was[_\s-]?)?(?:interrupted|disconnected|ended)/i,
  /http\/?2 stream failed/i,
  /network.?(?:error|failure)/i,
  /connection.?(?:error|refused|lost|closed)/i,
  /other side closed/i,
  /socket (?:hang up|connection was closed)/i,
  /fetch failed/i,
  /getaddrinfo/i,
  /\bE(?:NOTFOUND|AI_AGAIN|CONNRESET|CONNREFUSED|PIPE)\b/,
  /reset before headers/i,
  /timed? ?out/i,
  /\btimeout\b/i,
  /websocket.?(?:closed|error)/i,
  /ended without/i,
  /stream ended before/i,
  /(?:please|you can) retry your request/i,
];

function matches(patterns: readonly RegExp[], message: string): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

/**
 * Whether a failed provider call is worth retrying. Quota, billing, and auth
 * failures are deterministic and fail fast; transport and load failures retry.
 */
export function isRetryableProviderError(message: string, status?: number): boolean {
  if (matches(NON_RETRYABLE_PATTERNS, message)) return false;
  if (status !== undefined) {
    if (status === 408 || status === 409 || status === 429) return true;
    if (status >= 500) return true;
    if (status >= 400) return matches(RETRYABLE_PATTERNS, message);
  }
  return matches(RETRYABLE_PATTERNS, message);
}

/** Reads the delay a provider asked for, from `retry-after-ms` or `retry-after`. */
export function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds) {
    const value = Number.parseFloat(milliseconds);
    if (Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(retryAfter);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Local backoff for one retry attempt: exponential with 25% downward jitter. */
export function providerRetryDelayMs(
  policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs">,
  attempt: number,
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(Number.isSafeInteger(exponential) ? exponential : policy.maxDelayMs, policy.maxDelayMs);
  return Math.round(capped * (1 - Math.random() * 0.25));
}

export class RetryAbortError extends Error {
  constructor() {
    super("aborted during retry backoff");
    this.name = "RetryAbortError";
  }
}

export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RetryAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RetryAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RetryNotice {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

/** Runs one attempt with bounded retry on transient provider failures. */
export async function withProviderRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  signal: AbortSignal | undefined,
  options: {
    onRetry?: (notice: RetryNotice) => void;
    classify?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  const maxRetries = policy.enabled ? policy.maxRetries : 0;
  let attempt = 0;
  for (;;) {
    try {
      return await operation(attempt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = options.classify ? options.classify(error) : isRetryableProviderError(message);
      if (signal?.aborted || attempt >= maxRetries || !retryable) throw error;
      attempt += 1;
      const delayMs = providerRetryDelayMs(policy, attempt);
      options.onRetry?.({ attempt, maxAttempts: maxRetries, delayMs, reason: message });
      await sleepAbortable(delayMs, signal);
    }
  }
}

export interface RequestGuardOptions {
  /** Time allowed before response headers arrive. 0 disables the limit. */
  timeoutMs?: number;
  /** Longest silence allowed while streaming. 0 disables the limit. */
  idleTimeoutMs?: number;
}

export interface RequestGuard {
  signal: AbortSignal;
  /** Headers arrived: switch from the connect timer to the idle timer. */
  startIdle(): void;
  /** Progress arrived: reset the idle timer. */
  touch(): void;
  /** True when the guard aborted the request because a timer expired. */
  timedOut(): boolean;
  /** The timer that expired, for error messages. */
  timeoutKind(): "request" | "idle" | undefined;
  dispose(): void;
}

/**
 * Aborts a request when the provider does not answer or goes silent. A user
 * abort is forwarded unchanged so callers can tell cancellation from a timeout.
 */
export function createRequestGuard(
  userSignal: AbortSignal | undefined,
  options: RequestGuardOptions = {},
): RequestGuard {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const controller = new AbortController();
  let kind: "request" | "idle" | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onUserAbort = (): void => controller.abort();
  if (userSignal) {
    if (userSignal.aborted) controller.abort();
    else userSignal.addEventListener("abort", onUserAbort, { once: true });
  }

  const arm = (ms: number, next: "request" | "idle"): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (ms <= 0) return;
    timer = setTimeout(() => {
      kind = next;
      controller.abort();
    }, ms);
  };

  arm(timeoutMs, "request");

  return {
    signal: controller.signal,
    startIdle() {
      arm(idleTimeoutMs, "idle");
    },
    touch() {
      if (kind === undefined) arm(idleTimeoutMs, "idle");
    },
    timedOut: () => kind !== undefined,
    timeoutKind: () => kind,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      userSignal?.removeEventListener("abort", onUserAbort);
    },
  };
}

export function timeoutMessage(kind: "request" | "idle" | undefined, timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return kind === "idle"
    ? `provider stopped streaming for ${seconds}s`
    : `provider did not respond within ${seconds}s`;
}
