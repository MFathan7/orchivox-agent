import type { ChatRequest, ImageBlock, StreamEvent, Usage } from "../types/schema";
import type { LLMProvider } from "../provider/router";
import { btwUsage } from "./btw-usage";

export interface BtwTurn {
  id: string;
  topicId: string;
  sessionId: string;
  question: string;
  images?: ImageBlock[];
  answer: string;
  status: "running" | "complete" | "cancelled" | "error" | "interrupted";
  error?: string;
  finishReason?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  durationMs?: number;
  createdAt: number;
  updatedAt: number;
}

export interface BtwStore {
  listBtwTurns(sessionId: string): BtwTurn[];
  insertBtwTurn(turn: BtwTurn): void;
  updateBtwTurn(turn: BtwTurn): void;
  finishBtwTurn(turn: BtwTurn, usage: Usage): void;
}

export interface BtwInput {
  sessionId: string;
  question: string;
  topicId?: string;
  images?: ImageBlock[];
  activity?: string;
}

export interface BtwPrepared {
  provider: LLMProvider;
  request: ChatRequest;
  providerId?: string;
  model?: string;
}

interface Job {
  turn: BtwTurn;
  prepared: BtwPrepared;
  controller: AbortController;
  promise?: Promise<void>;
  checkpoint?: ReturnType<typeof setTimeout>;
}

export class BtwService {
  private readonly active = new Map<string, Job>();
  private readonly listeners = new Set<(turn: BtwTurn) => void>();
  private closed = false;

  constructor(private readonly options: {
    store: BtwStore;
    prepare: (input: BtwInput, history: BtwTurn[]) => BtwPrepared;
  }) {}

  subscribe(listener: (turn: BtwTurn) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  history(sessionId: string): BtwTurn[] {
    const turns = this.options.store.listBtwTurns(sessionId);
    const live = this.active.get(sessionId)?.turn;
    return live ? turns.map((turn) => turn.id === live.id ? structuredClone(live) : turn) : turns;
  }

  start(input: BtwInput): { accepted: boolean; topicId?: string; error?: string } {
    if (this.closed) return { accepted: false, error: "Side conversations are closed." };
    if (this.active.has(input.sessionId)) return { accepted: false, error: "A /btw answer is running. Wait for it or cancel it first." };
    if (!input.question.trim()) return { accepted: false, error: "Enter a question for this side conversation." };
    try {
      const history = input.topicId ? this.history(input.sessionId).filter((turn) => turn.topicId === input.topicId) : [];
      if (input.topicId && !history.length) throw new Error("This side conversation is unavailable in the current session.");
      const prepared = this.options.prepare(structuredClone(input), history);
      const now = Date.now();
      const turn: BtwTurn = {
        id: crypto.randomUUID(), topicId: input.topicId ?? crypto.randomUUID(), sessionId: input.sessionId,
        question: input.question.trim(), images: input.images ? structuredClone(input.images) : undefined,
        answer: "", status: "running", provider: prepared.providerId, model: prepared.model,
        createdAt: now, updatedAt: now,
      };
      this.options.store.insertBtwTurn(turn);
      const job: Job = { turn, prepared, controller: new AbortController() };
      this.active.set(input.sessionId, job);
      this.emit(turn);
      job.promise = this.read(job);
      return { accepted: true, topicId: turn.topicId };
    } catch (error) {
      return { accepted: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  cancel(sessionId: string): void { this.active.get(sessionId)?.controller.abort(); }

  async wait(sessionId: string): Promise<void> { await this.active.get(sessionId)?.promise; }

  async close(): Promise<void> {
    this.closed = true;
    const jobs = [...this.active.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.all(jobs.map((job) => job.promise));
    this.listeners.clear();
  }

  private emit(turn: BtwTurn): void {
    for (const listener of this.listeners) {
      try { listener(structuredClone(turn)); } catch { /* A view cannot interrupt the request. */ }
    }
  }

  private publish(job: Job): void {
    job.turn.updatedAt = Date.now();
    this.emit(job.turn);
    job.checkpoint ??= setTimeout(() => {
      job.checkpoint = undefined;
      try { this.options.store.updateBtwTurn(job.turn); } catch (error) { job.controller.abort(error); }
    }, 250);
  }

  private async read(job: Job): Promise<void> {
    const { turn, controller, prepared } = job;
    const clock = performance.now();
    let usage: Usage | undefined;
    let iterator: AsyncIterator<StreamEvent> | undefined;
    let completed = false;
    let rejectAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason ?? new Error("Side answer cancelled"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    try {
      controller.signal.throwIfAborted();
      iterator = prepared.provider.streamChat(prepared.request, controller.signal)[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([iterator.next(), cancelled]);
        if (next.done) { completed = true; break; }
        const event = next.value;
        if (event.type === "token") { turn.answer += event.text; this.publish(job); }
        else if (event.type === "final_text") { turn.answer = event.text; this.publish(job); }
        else if (event.type === "usage") {
          usage = event;
          turn.usage = btwUsage(event, true);
          this.publish(job);
        }
        else if (event.type === "tool_call_ready" || event.type === "tool_call_delta") throw new Error("Side conversations cannot execute tools.");
        else if (event.type === "error") throw new Error(event.code === "http_429"
          ? `The provider limited this side request. Wait for the main request to finish or check provider limits, then retry /btw.\n\n${event.message}`
          : event.message);
        else if (event.type === "done") {
          turn.finishReason = event.finish_reason;
          if (["error", "aborted", "tool_calls", "content_filter", "refusal"].includes(event.finish_reason)) throw new Error(`Side answer ended: ${event.finish_reason}`);
        }
      }
      controller.signal.throwIfAborted();
      if (!turn.finishReason) throw new Error("Side answer stream ended before completion.");
      if (!turn.answer.trim()) throw new Error("The model returned no visible answer.");
      turn.status = "complete";
    } catch (error) {
      turn.status = controller.signal.aborted && controller.signal.reason?.name === "AbortError" ? "cancelled" : "error";
      if (turn.status === "error") turn.error = error instanceof Error ? error.message : String(error);
    } finally {
      controller.signal.removeEventListener("abort", rejectAbort);
      if (job.checkpoint) clearTimeout(job.checkpoint);
      if (!completed) {
        controller.abort();
        void iterator?.return?.().catch(() => undefined);
      }
      turn.updatedAt = Date.now();
      turn.durationMs = Math.round(performance.now() - clock);
      turn.usage = btwUsage(usage, !completed || turn.status !== "complete");
      try { this.options.store.finishBtwTurn(turn, turn.usage); }
      catch (error) { turn.status = "error"; turn.error = `Could not save side answer: ${error instanceof Error ? error.message : String(error)}`; }
      this.active.delete(turn.sessionId);
      this.emit(turn);
    }
  }
}
