import type { LLMProvider } from "../provider/router";
import type { ChatRequest, StreamEvent, Usage } from "../types/schema";

export interface SideTurnInput {
  sessionId: string;
  purpose: "title" | "recap";
  provider: LLMProvider;
  request: ChatRequest;
  signal?: AbortSignal;
  timeoutMs?: number;
  onUsage?: (usage: Usage) => void;
}

export interface SideTurnResult {
  text: string;
  duration_ms: number;
  queue_ms: number;
  first_text_ms?: number;
}

interface Job {
  input: SideTurnInput;
  controller: AbortController;
  signal: AbortSignal;
  createdAt: number;
  finish: (result: SideTurnResult | undefined, error?: unknown) => void;
  promise: Promise<SideTurnResult>;
}

export class SideTurnRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Array<() => void> = [];
  private active = false;
  private closed = false;

  run(input: SideTurnInput): Promise<SideTurnResult> {
    if (this.closed) return Promise.reject(new Error("Background runner closed"));
    const key = `${input.sessionId}:${input.purpose}`;
    const existing = this.jobs.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
    const createdAt = Date.now();
    let resolve!: (result: SideTurnResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<SideTurnResult>((done, fail) => { resolve = done; reject = fail; });
    let finished = false;
    let started = false;
    const timer = setTimeout(() => controller.abort(new Error("Background request timed out")), input.timeoutMs ?? 30_000);
    const abort = () => {
      if (!started) job.finish(undefined, signal.reason ?? new Error("Background request cancelled"));
    };
    const job: Job = { input, controller, signal, createdAt, promise, finish: (result, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (this.jobs.get(key) === job) this.jobs.delete(key);
      if (error) reject(error); else resolve(result!);
    } };
    this.jobs.set(key, job);
    signal.addEventListener("abort", abort, { once: true });
    this.queue.push(() => {
      if (finished) { this.drain(); return; }
      started = true;
      this.active = true;
      void this.read(job).then((result) => job.finish(result), (error) => job.finish(undefined, error))
        .finally(() => { this.active = false; this.drain(); });
    });
    if (signal.aborted) abort();
    this.drain();
    return promise;
  }

  cancelSession(sessionId: string): void {
    for (const job of this.jobs.values()) {
      if (job.input.sessionId === sessionId) job.controller.abort(new Error("Session activity changed"));
    }
  }

  close(): void {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(new Error("Background runner closed"));
  }

  private drain(): void {
    if (!this.active) this.queue.shift()?.();
  }

  private async read(job: Job): Promise<SideTurnResult> {
    const startedAt = Date.now();
    const iterator = job.input.provider.streamChat(job.input.request, job.signal)[Symbol.asyncIterator]();
    let text = "";
    let firstText: number | undefined;
    let completed = false;
    let usage: Usage | undefined;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(job.signal.reason ?? new Error("Background request cancelled"));
      job.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      job.signal.throwIfAborted();
      for (;;) {
        const next = await Promise.race([iterator.next(), cancelled]);
        if (next.done) { completed = true; break; }
        const event: StreamEvent = next.value;
        if (event.type === "token") {
          firstText ??= Date.now() - startedAt;
          text += event.text;
          if (text.length > 8_192) throw new Error("Background response exceeded its text limit");
        } else if (event.type === "usage") {
          usage = event;
        } else if (event.type === "tool_call_ready" || event.type === "tool_call_delta") {
          throw new Error("Background requests cannot execute tools");
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
      job.signal.throwIfAborted();
      if (!text.trim()) throw new Error("Background request returned no text");
      return { text: text.trim(), duration_ms: Date.now() - startedAt, queue_ms: startedAt - job.createdAt, first_text_ms: firstText };
    } finally {
      try { job.input.onUsage?.(usage ?? { prompt_tokens: 0, completion_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_incomplete: true }); } catch {}
      job.signal.removeEventListener("abort", abort);
      if (!completed) {
        job.controller.abort();
        void iterator.return?.().catch(() => undefined);
      }
    }
  }
}
