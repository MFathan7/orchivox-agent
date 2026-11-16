export interface CdpEvent { method: string; params?: Record<string, any>; sessionId?: string }
export class CdpClient {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private failure?: Error;
  private disconnected?: () => void;
  private readonly eventFailures = new Set<(error: Error) => void>();
  private constructor(private readonly socket: WebSocket, private readonly timeoutMs: number) {
    socket.addEventListener("message", (event) => {
      try {
        const raw = String(event.data); if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error("CDP message exceeded 16 MiB.");
        const message = JSON.parse(raw);
        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id); if (!pending) return;
          if (message.error) pending.reject(new Error(`CDP: ${String(message.error.message).slice(0, 1000)}`)); else pending.resolve(message.result ?? {});
        } else if (typeof message.method === "string") for (const listener of this.listeners) listener(message);
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); socket.close(); }
    });
    socket.addEventListener("close", () => this.fail(new Error("CDP connection closed. Calls were not replayed.")));
    socket.addEventListener("error", () => this.fail(new Error("CDP connection failed. Calls were not replayed.")));
  }
  static async connect(url: string, signal?: AbortSignal, timeoutMs = 10000): Promise<CdpClient> {
    signal?.throwIfAborted(); const parsed = new URL(url);
    if (!["ws:", "wss:"].includes(parsed.protocol)) throw new Error("CDP requires a ws/wss endpoint.");
    const socket = new WebSocket(url), client = new CdpClient(socket, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); socket.removeEventListener("open", open); socket.removeEventListener("error", failed); socket.removeEventListener("close", failed); };
      const open = () => { cleanup(); resolve(); }, failed = () => { cleanup(); socket.close(); reject(new Error("CDP websocket could not connect.")); };
      const cancel = () => { cleanup(); socket.close(); reject(signal?.reason ?? new Error("CDP connection cancelled.")); };
      const timer = setTimeout(() => { cleanup(); socket.close(); reject(new Error("CDP connection timed out.")); }, timeoutMs);
      socket.addEventListener("open", open, { once: true }); socket.addEventListener("error", failed, { once: true }); socket.addEventListener("close", failed, { once: true });
      signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    });
    return client;
  }
  onDisconnect(listener: () => void) { this.disconnected = listener; if (this.failure) listener(); }
  get connected() { return !this.failure && this.socket.readyState === WebSocket.OPEN; }
  private fail(error: Error) { if (this.failure) return; this.failure = error; for (const pending of [...this.pending.values()]) pending.reject(error); for (const fail of [...this.eventFailures]) fail(error); this.listeners.clear(); this.disconnected?.(); }
  request(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal, sessionId?: string): Promise<any> {
    signal?.throwIfAborted(); if (!this.connected) return Promise.reject(this.failure ?? new Error("CDP is disconnected."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); this.pending.delete(id); };
      const cancel = () => { cleanup(); reject(signal?.reason ?? new Error("CDP request cancelled.")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`CDP ${method} timed out; effects may have occurred. The call was not replayed.`)); }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => { cleanup(); resolve(value); }, reject: (error) => { cleanup(); reject(error); } });
      signal?.addEventListener("abort", cancel, { once: true });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); } catch (error) { cleanup(); reject(error); }
      if (signal?.aborted) cancel();
    });
  }
  waitFor(method: string, sessionId: string, signal?: AbortSignal): Promise<Record<string, any> | undefined> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); this.listeners.delete(listener); this.eventFailures.delete(failed); };
      const listener = (event: CdpEvent) => { if (event.method === method && event.sessionId === sessionId) { cleanup(); resolve(event.params); } };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const cancel = () => { cleanup(); reject(signal?.reason ?? new Error("CDP event wait cancelled.")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`CDP ${method} event timed out.`)); }, this.timeoutMs);
      this.eventFailures.add(failed); this.listeners.add(listener); signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    });
  }
  close() { this.fail(new Error("CDP client closed.")); this.socket.close(); }
}
