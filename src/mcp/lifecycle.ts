import { z } from "zod";
import type { ToolProgress } from "../types/tool-output";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export class McpManagedTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  constructor(private readonly transport: Transport, private readonly failed: (error: Error) => void) {}
  async start() {
    this.transport.onclose = () => this.onclose?.();
    this.transport.onerror = (error) => { this.failed(error); this.onerror?.(error); };
    this.transport.onmessage = (message, extra) => this.onmessage?.(message, extra);
    await this.transport.start();
  }
  send(...args: Parameters<Transport["send"]>) { return this.transport.send(...args); }
  close() { return this.transport.close(); }
  get sessionId() { return this.transport.sessionId; }
  setProtocolVersion(version: string) { this.transport.setProtocolVersion?.(version); }
}

export class McpConnectionTimeout extends Error {
  constructor() { super("MCP connection timed out."); }
}
export class McpConnectionReplaced extends Error {
  constructor() { super("MCP connection was disconnected or replaced."); }
}

export class McpConnectionPool {
  private active = 0;
  private readonly waiting: Array<{ start: () => void; cancel: () => void }> = [];
  constructor(private limit: number) {}
  setLimit(limit: number) { this.limit = limit; while (this.active < this.limit && this.waiting.length) this.waiting.shift()!.start(); }
  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const entry = { start: () => { signal.removeEventListener("abort", entry.cancel); this.active++; resolve(); }, cancel: () => {
        const index = this.waiting.indexOf(entry); if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason ?? new McpConnectionReplaced());
      } };
      if (this.active < this.limit) entry.start(); else { this.waiting.push(entry); signal.addEventListener("abort", entry.cancel, { once: true }); }
    });
    try { signal.throwIfAborted(); return await operation(); }
    finally { this.active--; while (this.active < this.limit && this.waiting.length) this.waiting.shift()!.start(); }
  }
}

const ProgressSchema = z.object({ progress: z.number().finite().nonnegative(), total: z.number().finite().nonnegative().optional(), message: z.string().optional() });
export class McpProgressRelay {
  private last = -1;
  private pending?: ToolProgress;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private emittedAt = -Infinity;
  constructor(private readonly send: ((value: ToolProgress) => void) | undefined, private readonly alive: () => boolean, private readonly clean: (value: string) => string) {}
  accept(value: unknown): void {
    if (this.closed || !this.alive() || !this.send) return;
    const parsed = ProgressSchema.safeParse(value); if (!parsed.success || parsed.data.progress < this.last) return;
    const { progress, total, message } = parsed.data; this.last = progress;
    this.pending = { progress, ...(total !== undefined && total >= progress ? { total } : {}),
      ...(message ? { message: Bun.stripANSI(this.clean(message)).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 512) } : {}) };
    if (performance.now() - this.emittedAt >= 100) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 100);
  }
  private flush() {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (this.pending && !this.closed && this.alive()) { this.send?.(this.pending); this.emittedAt = performance.now(); }
    this.pending = undefined;
  }
  close(flush: boolean) { if (flush) this.flush(); this.closed = true; this.pending = undefined; if (this.timer) clearTimeout(this.timer); }
}
