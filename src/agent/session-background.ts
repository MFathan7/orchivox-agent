import type { BackgroundConfig } from "../config/loader";
import type { SessionRecord } from "../memory/sqlite";
import { normalizeTitle } from "./session-title";
import { RECAP_INSTRUCTION, TITLE_INSTRUCTION } from "./prompt";

interface BackgroundStore {
  getSession(id: string): SessionRecord | undefined;
  updateSession(id: string, patch: { title: string }): unknown;
  saveRecap(id: string, text: string): void;
}

export interface BackgroundView {
  sessionId?: string;
  busy: boolean;
  blocked: boolean;
  draft: boolean;
  workers: boolean;
}

export class SessionBackgroundJobs {
  private sessionId?: string;
  private epoch = 0;
  private eligible = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private recap?: AbortController;
  private title?: AbortController;
  private titleTried = false;

  constructor(private readonly options: {
    config: () => BackgroundConfig;
    view: () => BackgroundView;
    store: BackgroundStore;
    run: (input: { sessionId: string; purpose: "title" | "recap"; instruction: string; signal: AbortSignal }) => Promise<{ text: string }>;
    onTitle: (sessionId: string, title: string) => void;
    onRecap: (sessionId: string, text: string) => void;
  }) {}

  beginTurn(sessionId: string): void {
    this.invalidate();
    this.sessionId = sessionId;
    this.eligible = false;
    this.titleTried = false;
  }

  activity(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.recap?.abort();
    this.recap = undefined;
  }

  async ensureTitle(sessionId: string, expectedTitle: string): Promise<void> {
    if (this.closed || this.titleTried || this.sessionId !== sessionId || !this.options.config().titles) return;
    this.titleTried = true;
    const epoch = this.epoch;
    const controller = new AbortController();
    this.title = controller;
    try {
      const result = await this.options.run({ sessionId, purpose: "title", instruction: TITLE_INSTRUCTION, signal: controller.signal });
      const title = normalizeTitle(result.text);
      if (!title || controller.signal.aborted || epoch !== this.epoch || this.closed) return;
      if (this.options.store.getSession(sessionId)?.title !== expectedTitle) return;
      this.options.store.updateSession(sessionId, { title });
      this.options.onTitle(sessionId, title);
    } catch {
      // The provisional title remains usable after a provider failure.
    } finally {
      if (this.title === controller) this.title = undefined;
    }
  }

  endTurn(sessionId: string, eligible: boolean): void {
    if (this.sessionId !== sessionId || this.closed) return;
    this.eligible = eligible;
    this.refresh();
  }

  refresh(): void {
    if (this.closed) return;
    const view = this.options.view();
    if (view.sessionId !== this.sessionId) {
      this.invalidate();
      this.sessionId = view.sessionId;
      this.eligible = false;
    }
    if (!this.options.config().recap || view.busy || view.blocked || view.draft || view.workers) {
      this.activity();
      return;
    }
    if (!this.eligible || !this.sessionId || this.timer || this.recap) return;
    const epoch = this.epoch;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.generateRecap(epoch);
    }, this.options.config().recap_idle_seconds * 1000);
    this.timer.unref?.();
  }

  invalidate(): void {
    this.epoch += 1;
    this.eligible = false;
    this.activity();
    this.title?.abort();
    this.title = undefined;
  }

  close(): void {
    this.closed = true;
    this.invalidate();
  }

  private async generateRecap(epoch: number): Promise<void> {
    const view = this.options.view();
    const sessionId = this.sessionId;
    if (!sessionId || !this.eligible || view.busy || view.blocked || view.draft || view.workers || epoch !== this.epoch) return;
    const controller = new AbortController();
    this.recap = controller;
    this.eligible = false;
    try {
      const result = await this.options.run({ sessionId, purpose: "recap", instruction: RECAP_INSTRUCTION, signal: controller.signal });
      const current = this.options.view();
      if (controller.signal.aborted || this.closed || epoch !== this.epoch || current.sessionId !== sessionId || current.busy || current.blocked || current.draft || current.workers) return;
      if (!this.options.store.getSession(sessionId)) return;
      const text = result.text.replace(/\s+/g, " ").trim().split(" ").slice(0, 40).join(" ");
      if (!text) return;
      this.options.store.saveRecap(sessionId, text);
      this.options.onRecap(sessionId, text);
    } catch {
      // Recap failures never start a foreground turn or retry loop.
    } finally {
      if (this.recap === controller) this.recap = undefined;
    }
  }
}
