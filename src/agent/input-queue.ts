import { InputRunCancelled, interruptedRun, type InputRunContext, type InputRunResult } from "./run-lifecycle";

export type InputQueueStatus = "pending" | "editing" | "running" | "complete" | "failed" | "cancelled" | "interrupted";

export interface QueuedInput<T> {
  id: string;
  sessionId: string;
  sequence: number;
  input: T;
  status: InputQueueStatus;
  createdAt: number;
  updatedAt: number;
  ownerId?: string;
  ownerPid?: number;
  editToken?: string;
  error?: string;
}

export interface QueueExpected {
  statuses: InputQueueStatus[];
  ownerId?: string;
  editToken?: string;
  head?: boolean;
}
export type QueuePatch<T> = Partial<Pick<QueuedInput<T>, "input" | "status" | "ownerId" | "ownerPid" | "editToken" | "error">>;

export interface InputQueueStore<T> {
  list(sessionId: string): QueuedInput<T>[];
  get(id: string, sessionId: string): QueuedInput<T> | undefined;
  insert(item: QueuedInput<T>): QueuedInput<T>;
  change(id: string, sessionId: string, expected: QueueExpected, patch: QueuePatch<T>): QueuedInput<T> | undefined;
}

export const LIVE_QUEUE_STATUSES: InputQueueStatus[] = ["pending", "editing", "running"];

export function queueChangeAllowed<T>(item: QueuedInput<T>, expected: QueueExpected): boolean {
  return expected.statuses.includes(item.status)
    && (expected.ownerId === undefined || item.ownerId === expected.ownerId)
    && (expected.editToken === undefined || item.editToken === expected.editToken);
}

export class MemoryInputQueueStore<T> implements InputQueueStore<T> {
  private readonly records = new Map<string, QueuedInput<T>>();
  private sequence = 0;
  list(sessionId: string): QueuedInput<T>[] {
    return [...this.records.values()].filter((item) => item.sessionId === sessionId && [...LIVE_QUEUE_STATUSES, "interrupted"].includes(item.status))
      .sort((a, b) => a.sequence - b.sequence).map((item) => structuredClone(item));
  }
  get(id: string, sessionId: string): QueuedInput<T> | undefined {
    const item = this.records.get(id);
    return item?.sessionId === sessionId ? structuredClone(item) : undefined;
  }
  insert(item: QueuedInput<T>): QueuedInput<T> {
    if (this.records.has(item.id)) throw new Error("This queued message already exists.");
    const record = { ...structuredClone(item), sequence: ++this.sequence };
    this.records.set(item.id, record);
    return structuredClone(record);
  }
  change(id: string, sessionId: string, expected: QueueExpected, patch: QueuePatch<T>): QueuedInput<T> | undefined {
    const item = this.get(id, sessionId);
    if (!item || !queueChangeAllowed(item, expected)) return;
    if (expected.head && this.list(sessionId).some((other) => other.id !== id && LIVE_QUEUE_STATUSES.includes(other.status)
      && (other.sequence < item.sequence || other.status === "running"))) return;
    const changed = { ...item, ...structuredClone(patch), updatedAt: Date.now() };
    this.records.set(id, changed);
    return structuredClone(changed);
  }
}

export class InputQueue<T> {
  private readonly store: InputQueueStore<T>;
  private readonly ownerId = crypto.randomUUID();
  private readonly edits = new Map<string, string>();
  private records: QueuedInput<T>[] = [];
  private sessionId = "";
  private generation = 0;
  private processing = false;
  private closed = false;
  private held = false;
  private holdReason?: string;
  private controller?: AbortController;
  private running?: QueuedInput<T>;
  private completion: Promise<void> = Promise.resolve();

  constructor(private readonly handlers: {
    blocked: () => boolean;
    run: (input: T, item: QueuedInput<T>, context: InputRunContext) => Promise<InputRunResult | void>;
    onError: (error: unknown) => void;
    onChange?: () => void;
    store?: InputQueueStore<T>;
  }) { this.store = handlers.store ?? new MemoryInputQueueStore<T>(); }

  get active(): boolean { return this.processing; }
  get size(): number { return this.records.filter((item) => item.status === "pending" || item.status === "editing").length; }
  get items(): readonly QueuedInput<T>[] { return this.records; }
  get paused(): boolean { return this.held; }
  get pauseReason(): string | undefined { return this.holdReason; }
  get pauseDetail(): string | undefined { return this.held ? this.holdDetail : undefined; }
  private holdDetail?: string;
  get stopping(): boolean { return this.processing && Boolean(this.controller?.signal.aborted); }
  get runningItem(): QueuedInput<T> | undefined { return this.running; }

  switchSession(sessionId: string): void {
    if (this.sessionId === sessionId) { this.refresh(); return; }
    this.controller?.abort(new InputRunCancelled("interrupted"));
    this.releaseEdits();
    this.sessionId = sessionId;
    this.generation++;
    this.held = true;
    this.refresh();
    this.held = this.records.some((item) => LIVE_QUEUE_STATUSES.includes(item.status));
    this.holdReason = this.held ? "restored" : undefined;
    this.holdDetail = undefined;
  }

  refresh(): void { this.records = this.store.list(this.sessionId); }

  enqueue(input: T, sessionId = this.sessionId || "local"): number {
    if (this.closed) throw new Error("Input queue is closed");
    this.switchSession(sessionId);
    const queued = this.processing || this.handlers.blocked() || this.size > 0 || this.held;
    const now = Date.now();
    this.store.insert({ id: crypto.randomUUID(), sessionId, sequence: 0, input, status: "pending", createdAt: now, updatedAt: now });
    this.refresh();
    const position = queued ? this.size : 0;
    void this.drain();
    return position;
  }

  get(id: string): QueuedInput<T> | undefined { return this.store.get(id, this.sessionId); }

  beginEdit(id: string): QueuedInput<T> | undefined {
    const token = crypto.randomUUID();
    const item = this.store.change(id, this.sessionId, { statuses: ["pending"] }, { status: "editing", editToken: token, ownerId: this.ownerId, ownerPid: process.pid });
    if (item) this.edits.set(id, token);
    this.refresh();
    this.changed();
    return item;
  }

  saveEdit(id: string, editToken: string, input: T): boolean { return this.finishEdit(id, editToken, { input }); }
  cancelEdit(id: string, editToken: string): boolean { return this.finishEdit(id, editToken, {}); }

  private finishEdit(id: string, editToken: string, patch: QueuePatch<T>): boolean {
    const item = this.store.change(id, this.sessionId, { statuses: ["editing"], editToken, ownerId: this.ownerId },
      { ...patch, status: "pending", editToken: undefined, ownerId: undefined, ownerPid: undefined });
    if (item) this.edits.delete(id);
    this.refresh();
    this.changed();
    void this.drain();
    return Boolean(item);
  }

  cancel(id: string): boolean {
    const item = this.store.change(id, this.sessionId, { statuses: ["pending", "editing"] },
      { status: "cancelled", editToken: undefined, ownerId: undefined, ownerPid: undefined });
    if (item) this.edits.delete(id);
    this.refresh();
    this.changed();
    void this.drain();
    return Boolean(item);
  }

  cancelActive(): boolean {
    if (!this.running || !this.controller || this.controller.signal.aborted) return false;
    this.held = true;
    this.holdReason = "cancelled";
    this.holdDetail = "Main turn stopped by the user.";
    this.controller.abort(new InputRunCancelled());
    this.changed();
    return true;
  }

  resume(): boolean {
    this.refresh();
    if (this.stopping || (!this.running && this.records.some((item) => item.status === "running"))) return false;
    this.held = false; this.holdReason = undefined; this.holdDetail = undefined; this.changed(); void this.drain(); return true;
  }

  private head(): QueuedInput<T> | undefined { return this.records.find((item) => LIVE_QUEUE_STATUSES.includes(item.status)); }
  private ready(): boolean { return !this.processing && !this.closed && !this.held && !this.handlers.blocked() && this.head()?.status === "pending"; }

  drain(): Promise<void> {
    if (!this.ready()) return this.completion;
    this.processing = true;
    this.completion = this.process(this.generation).catch((error) => {
      this.held = true;
      this.holdReason = "storage";
      if (!this.closed) this.handlers.onError(error);
    }).finally(() => {
      this.processing = false;
      this.running = undefined;
      this.controller = undefined;
      if (this.closed) return;
      this.changed();
      if (this.ready()) void this.drain();
    });
    return this.completion;
  }

  clear(): void {
    for (const item of this.records) this.store.change(item.id, this.sessionId, { statuses: ["pending", "editing"] }, { status: "cancelled" });
    this.edits.clear();
    this.refresh();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller?.abort(new InputRunCancelled("interrupted"));
    this.releaseEdits();
    if (this.running) this.store.change(this.running.id, this.running.sessionId, { statuses: ["running"], ownerId: this.ownerId }, { status: "interrupted" });
    this.records = [];
  }

  private releaseEdits(): void {
    for (const [id, editToken] of this.edits) this.store.change(id, this.sessionId, { statuses: ["editing"], editToken, ownerId: this.ownerId },
      { status: "pending", editToken: undefined, ownerId: undefined, ownerPid: undefined });
    this.edits.clear();
  }

  private changed(): void { if (!this.closed) this.handlers.onChange?.(); }

  private async process(generation: number): Promise<void> {
    while (!this.closed && !this.held && generation === this.generation && !this.handlers.blocked()) {
      this.refresh();
      const head = this.head();
      if (head?.status !== "pending") break;
      const item = this.store.change(head.id, this.sessionId, { statuses: ["pending"], head: true }, { status: "running", ownerId: this.ownerId, ownerPid: process.pid });
      if (!item) { this.refresh(); break; }
      this.running = item;
      const controller = new AbortController();
      this.controller = controller;
      const context: InputRunContext = {
        signal: controller.signal,
        isCurrent: () => !this.closed && generation === this.generation && this.running?.id === item.id,
        assertCurrent: () => { controller.signal.throwIfAborted(); if (!context.isCurrent()) throw new InputRunCancelled("interrupted"); },
      };
      this.refresh();
      this.changed();
      let result: InputRunResult = { status: "complete" };
      try {
        result = await this.handlers.run(item.input, item, context) ?? { status: "complete" };
        if (controller.signal.aborted) result = interruptedRun(controller.signal.reason, controller.signal);
      }
      catch (failure) {
        result = interruptedRun(failure, controller.signal);
        if (result.status === "failed" && context.isCurrent()) this.handlers.onError(failure);
      }
      finally {
        if (result.status !== "complete" && context.isCurrent()) {
          this.held = true;
          this.holdReason = result.status;
          this.holdDetail = result.reason;
        }
        this.running = undefined;
        this.controller = undefined;
        if (!this.closed) {
          this.store.change(item.id, item.sessionId, { statuses: ["running"], ownerId: this.ownerId },
            { status: result.status, error: result.reason });
          this.refresh(); this.changed();
        }
      }
    }
  }
}
