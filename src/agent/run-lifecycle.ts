import type { StreamEvent } from "../types/schema";

export interface InputRunResult {
  status: "complete" | "cancelled" | "failed" | "interrupted";
  reason?: string;
}

export class InputRunCancelled extends Error {
  constructor(readonly status: "cancelled" | "interrupted" = "cancelled") {
    super(status === "cancelled" ? "Processing cancelled by the user." : "Processing interrupted because the session ended.");
    this.name = "InputRunCancelled";
  }
}

export interface InputRunContext {
  signal: AbortSignal;
  isCurrent: () => boolean;
  assertCurrent: () => void;
}

export function interruptedRun(error: unknown, signal?: AbortSignal): InputRunResult {
  const cause = signal?.aborted ? signal.reason : error;
  return cause instanceof InputRunCancelled
    ? { status: cause.status, reason: cause.message }
    : signal?.aborted ? { status: "cancelled", reason: "Processing cancelled." }
    : { status: "failed", reason: error instanceof Error ? error.message : String(error) };
}

export function mainTurnResult(finishReason: string | undefined, aborted: boolean, fatalError = false): InputRunResult {
  if (aborted || finishReason === "aborted") return { status: "cancelled", reason: "Main turn stopped." };
  if (finishReason === "stop" && !fatalError) return { status: "complete" };
  return { status: "failed", reason: finishReason ? `Main turn ended: ${finishReason}.` : "Main stream ended without completion." };
}

export class SessionViewLease {
  constructor(private readonly captured: { id?: string; epoch: number },
    private readonly view: () => { id?: string; epoch: number; closed?: boolean },
    private readonly runContext?: InputRunContext) {}

  isCurrent(): boolean {
    const view = this.view();
    return !view.closed && view.id === this.captured.id && view.epoch === this.captured.epoch && (this.runContext?.isCurrent() ?? true);
  }

  assertCurrent(): void {
    this.runContext?.signal.throwIfAborted();
    if (!this.isCurrent()) throw new InputRunCancelled("interrupted");
  }

  async run<T>(work: () => Promise<T>, cleanup: () => void): Promise<T> {
    try { this.assertCurrent(); return await work(); }
    finally { if (this.isCurrent()) cleanup(); }
  }
}

export async function withRunSignal<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return work();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new InputRunCancelled());
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([cancelled, Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    })]);
  }
  finally { signal.removeEventListener("abort", abort); }
}

export async function* mainTurnEvents(events: AsyncIterable<StreamEvent>, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  try { yield* events; }
  catch (error) {
    if (!signal.aborted) throw error;
    yield { type: "done", finish_reason: "aborted" };
  }
}
