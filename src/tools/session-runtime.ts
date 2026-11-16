import { currentTurnContext } from "../agent/turn-context";
import { workspaceRoot } from "./workspace";

export function toolSessionScope() {
  const turn = currentTurnContext();
  return { key: JSON.stringify([turn?.sessionId ?? turn?.runId ?? "ephemeral", turn?.workerId ?? "main", workspaceRoot(process.cwd())]), worker: turn?.workerId };
}
interface Closable { close(): Promise<void> }
interface Slot<T> { controller: AbortController; worker?: string; value?: T; starting?: Promise<T>; timer?: ReturnType<typeof setTimeout>; active: number }
export class ToolSessionSlots<T extends Closable> {
  private readonly entries = new Map<string, Slot<T>>();
  private closed = false;
  constructor(private readonly limit = 4, private readonly idleMs = 600000) {}
  peek(): T | undefined { return this.entries.get(toolSessionScope().key)?.value; }
  starting(): boolean { return !!this.entries.get(toolSessionScope().key)?.starting; }
  private arm(key: string, slot: Slot<T>) {
    if (slot.timer) clearTimeout(slot.timer);
    if (slot.active || this.entries.get(key) !== slot) return;
    slot.timer = setTimeout(() => { void this.remove(key).catch(() => {}); }, this.idleMs); slot.timer.unref();
  }
  async create(factory: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Runtime has closed.");
    const { key, worker } = toolSessionScope();
    if (this.entries.has(key)) throw new Error("This agent/workspace already has a session. Close it before starting another.");
    if (this.entries.size >= this.limit) throw new Error(`Session capacity ${this.limit} reached. Close an unused session first.`);
    const slot: Slot<T> = { controller: new AbortController(), worker, active: 0 }; this.entries.set(key, slot);
    const combined = signal ? AbortSignal.any([signal, slot.controller.signal]) : slot.controller.signal;
    slot.starting = (async () => {
      try {
        const value = await factory(combined);
        if (combined.aborted || this.entries.get(key) !== slot) { await value.close(); combined.throwIfAborted(); throw new Error("Session replaced during startup."); }
        slot.value = value; return value;
      } catch (error) { if (this.entries.get(key) === slot) this.entries.delete(key); throw error; }
      finally { slot.starting = undefined; this.arm(key, slot); }
    })();
    return slot.starting;
  }
  async use<R>(signal: AbortSignal | undefined, operation: (value: T, signal: AbortSignal) => Promise<R>): Promise<R> {
    const { key } = toolSessionScope(), slot = this.entries.get(key);
    if (!slot?.value) throw new Error(slot?.starting ? "Session is still starting." : "No session for this agent/workspace. Start one explicitly.");
    if (slot.timer) clearTimeout(slot.timer); slot.active++;
    const combined = signal ? AbortSignal.any([signal, slot.controller.signal]) : slot.controller.signal;
    try { combined.throwIfAborted(); const result = await operation(slot.value, combined); combined.throwIfAborted(); return result; }
    catch (error) { if (combined.aborted) await this.remove(key, slot); throw error; }
    finally { slot.active--; this.arm(key, slot); }
  }
  private async remove(key: string, expected?: Slot<T>): Promise<void> {
    const slot = this.entries.get(key); if (!slot || expected && slot !== expected) return;
    this.entries.delete(key); if (slot.timer) clearTimeout(slot.timer); slot.controller.abort(new Error("Session closed."));
    await slot.value?.close(); await slot.starting?.catch(() => {});
  }
  closeCurrent() { return this.remove(toolSessionScope().key); }
  closeIfCurrent(value: T) { const key = toolSessionScope().key, slot = this.entries.get(key); return slot?.value === value ? this.remove(key, slot) : Promise.resolve(); }
  async stopForWorker(worker: string) { await Promise.all([...this.entries].filter(([, slot]) => slot.worker === worker).map(([key]) => this.remove(key))); }
  async dispose() { this.closed = true; await Promise.all([...this.entries.keys()].map((key) => this.remove(key))); }
}

export function toolDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, ms);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal?.reason); };
    signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
  });
}
