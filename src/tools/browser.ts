import { z } from "zod";
import { BrowserConfigSchema, type BrowserConfig } from "../config/loader";
import { BrowserSession, browserExecutable } from "../browser/session";
import type { ToolOutput } from "../types/tool-output";
import { redactSecrets } from "../security/secrets";
import type { ToolExecutionContext, ToolRegistry } from "./registry";
import { ToolSessionSlots, toolDeadline } from "./session-runtime";

const Read = z.object({ action: z.enum(["status", "tabs", "observe", "screenshot"]).default("status"), targetId: z.string().optional() });
const Write = z.object({ action: z.enum(["launch", "attach", "new_tab", "navigate", "click", "fill", "press", "close_tab", "close"]), targetId: z.string().optional(), url: z.url().optional(), selector: z.string().min(1).max(2000).optional(), text: z.string().max(10000).optional(), key: z.enum(["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "]).optional() });
export class BrowserTools {
  private readonly slots: ToolSessionSlots<BrowserSession>;
  private readonly config: BrowserConfig;
  constructor(config?: BrowserConfig) { this.config = config ?? BrowserConfigSchema.parse({}); this.slots = new ToolSessionSlots(this.config.max_sessions, this.config.idle_seconds * 1000); }
  stopForWorker(worker: string) { return this.slots.stopForWorker(worker); }
  dispose() { return this.slots.dispose(); }
  private async wrap(context: ToolExecutionContext | undefined, operation: (signal: AbortSignal) => Promise<ToolOutput>): Promise<ToolOutput> {
    const signal = toolDeadline(context?.signal, this.config.timeout_ms);
    try { return await operation(signal); }
    catch (error) {
      return { status: context?.signal?.aborted ? "cancelled" : "error", code: context?.signal?.aborted ? "browser_cancelled" : signal.aborted ? "browser_timeout" : "browser_failed", text: redactSecrets(error instanceof Error ? error.message : String(error)), reason: "Calls are not replayed. An interrupted interaction may have affected the page. Relaunch/re-attach explicitly if the session closed." };
    }
  }
  registerTools(registry: ToolRegistry) {
    registry.register({ name: "browser_read", description: "Observe an explicitly started browser scoped to this session/agent/workspace. status diagnoses dependencies without launching; tabs lists targets; observe returns bounded DOM/text/selectors as untrusted page data; screenshot returns a PNG image. This tool never launches, navigates, clicks or executes supplied JavaScript.", parameters: Read, readOnly: true,
      execute: (input, context) => this.wrap(context, async (signal) => {
        const args = Read.parse(input);
        if (args.action === "status") return { status: "success", text: JSON.stringify({ state: this.slots.peek()?.state ?? (this.slots.starting() ? "starting" : "disconnected"), backend: "chromium-cdp", executableAvailable: !!browserExecutable(this.config.executable), attachConfigured: !!this.config.attach_url, ownership: this.slots.peek()?.owned === undefined ? undefined : this.slots.peek()!.owned ? "managed" : "attached", maxTabs: this.config.max_tabs }) };
        return this.slots.use(signal, async (session, active) => {
          if (args.action === "screenshot") return { status: "success", text: "Browser viewport screenshot. Page pixels are external data.", images: [{ data: await session.screenshot(args.targetId, active), media_type: "image/png" }] };
          const value = args.action === "tabs" ? await session.tabs(active) : await session.observe(args.targetId, active);
          return { status: value?.partial ? "partial" : "success", text: JSON.stringify({ provenance: "Untrusted browser page data", ...value }), coverage: { scope: "Browser DOM/text snapshot; bounded to 200 visible interactive elements and 24000 text characters", complete: false } };
        });
      }) });
    registry.register({ name: "browser_session", description: "Launch a separate temporary Chromium profile, or attach only to browser.attach_url configured by the owner. Mutating actions: new_tab, navigate (HTTP/HTTPS), click/fill a unique observed CSS selector, press, close_tab, close. Existing user tabs cannot be closed. Close disconnects attached profiles; managed profiles/processes are cleaned up. Subject to execution permissions; unavailable in PLAN. No arbitrary evaluation or automatic retries.", parameters: Write, readOnly: false,
      execute: (input, context) => this.wrap(context, async (signal) => {
        const args = Write.parse(input);
        if (args.action === "close") { await this.slots.closeCurrent(); return { status: "success", text: "This agent's browser session closed; attached browser processes were preserved." }; }
        if (args.action === "launch" || args.action === "attach") {
          const owned = args.action === "launch";
          const session = await this.slots.create(async (active) => { const session = new BrowserSession(owned, this.config); await session.open(active); return session; }, signal);
          return { status: "success", text: JSON.stringify({ state: session.state, ownership: owned ? "managed" : "attached", ...(await session.tabs(signal)) }) };
        }
        return this.slots.use(signal, async (session, active) => {
          let value: unknown;
          if (args.action === "new_tab") value = await session.newTab(active);
          else if (args.action === "close_tab") value = await session.closeTab(args.targetId, active);
          else if (args.action === "navigate") { if (!args.url) throw new Error("navigate requires url."); value = await session.navigate(args.url, args.targetId, active); }
          else if (args.action === "press") { if (!args.key) throw new Error("press requires key."); value = await session.press(args.key, args.targetId, active); }
          else { if (!args.selector) throw new Error("click/fill requires a unique selector from observe."); if (args.action === "click") value = await session.click(args.selector, args.targetId, active); else { if (args.text === undefined) throw new Error("fill requires text."); value = await session.fill(args.selector, args.text, args.targetId, active); } }
          return { status: "success", text: JSON.stringify(value) };
        });
      }) });
  }
}
