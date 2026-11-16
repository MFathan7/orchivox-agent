export const FRAME_INTERVAL_MS = 1000 / 30;

export class FrameClock {
  private timer?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<() => void>();
  private readonly requests = new Set<() => void>();
  private time = performance.now();
  private lastTick = 0;
  private cost = 0;
  private dirty = false;
  private ticking = false;
  private closed = false;

  constructor(private readonly options: {
    blocked?: () => boolean;
    paint?: () => boolean;
    intervalMs?: number;
  } = {}) {}

  snapshot = (): number => this.time;

  subscribe = (listener: () => void): (() => void) => {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    this.schedule();
    return () => { this.listeners.delete(listener); this.stopIfIdle(); };
  };

  request(callback: () => void): void {
    if (this.closed) return;
    this.requests.add(callback);
    this.schedule();
  }

  cancel(callback: () => void): void {
    this.requests.delete(callback);
    this.stopIfIdle();
  }

  invalidate(): void {
    if (this.closed) return;
    this.dirty = true;
    this.schedule();
  }

  dispose(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.requests.clear();
    this.listeners.clear();
  }

  private stopIfIdle(): void {
    if (this.listeners.size || this.requests.size || this.dirty || this.ticking) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.closed || this.ticking || this.timer !== undefined) return;
    const interval = Math.max(this.options.intervalMs ?? FRAME_INTERVAL_MS, Math.min(200, this.cost * 2));
    const delay = Math.max(0, interval - (performance.now() - this.lastTick));
    this.timer = setTimeout(this.tick, delay);
    this.timer.unref?.();
  }

  private tick = (): void => {
    this.timer = undefined;
    if (this.closed) return;
    if (this.options.blocked?.()) {
      this.lastTick = performance.now();
      this.schedule();
      return;
    }
    this.ticking = true;
    const started = performance.now();
    this.lastTick = started;
    this.time = started;
    const requests = [...this.requests];
    this.requests.clear();
    this.dirty = false;
    try {
      for (const request of requests) request();
      for (const listener of [...this.listeners]) listener();
      this.dirty = this.options.paint?.() ?? false;
    } finally {
      this.cost = performance.now() - started;
      this.ticking = false;
      if (this.listeners.size || this.requests.size || this.dirty) this.schedule();
    }
  };
}

export const fallbackFrameClock = new FrameClock();
