import { createHash } from "node:crypto";
import { z } from "zod";
import { DesktopConfigSchema, type DesktopConfig } from "../config/loader";
import { DesktopFailure, linuxDesktopRequest } from "../desktop/client";
import { redactSecrets } from "../security/secrets";
import type { ToolOutput } from "../types/tool-output";
import type { ToolExecutionContext, ToolRegistry } from "./registry";
import { ToolSessionSlots, toolDeadline } from "./session-runtime";

const Identity = z.object({ bus: z.string().min(1).max(200), path: z.string().min(1).max(2000), pid: z.number().int().nonnegative(), start: z.string().nullable(), name: z.string().max(500), role: z.number().int() });
type Identity = z.infer<typeof Identity>;
const identifier = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 40);
class DesktopScope {
  readonly windows = new Map<string, Identity>();
  readonly elements = new Map<string, { windowId: string; identity: Identity; actions: Array<{ index: number; name: string }>; editable: boolean }>();
  selected?: string;
  async close() { this.windows.clear(); this.elements.clear(); this.selected = undefined; }
}
export class DesktopTools {
  private readonly config: DesktopConfig;
  private readonly slots: ToolSessionSlots<DesktopScope>;
  constructor(config?: DesktopConfig, private readonly backend = linuxDesktopRequest, private readonly platform: string = process.platform) { this.config = config ?? DesktopConfigSchema.parse({}); this.slots = new ToolSessionSlots(this.config.max_sessions, this.config.idle_seconds * 1000); }
  stopForWorker(worker: string) { return this.slots.stopForWorker(worker); }
  dispose() { return this.slots.dispose(); }
  private program() { return this.config.python ? Bun.which(this.config.python) : Bun.which("python3") ?? Bun.which("python"); }
  private async invoke(request: Record<string, unknown>, signal: AbortSignal) {
    if (this.platform !== "linux") throw new DesktopFailure("desktop_platform_unsupported", "This backend supports Linux only. Windows/macOS are not implemented or verified.");
    if (!this.config.enabled) throw new DesktopFailure("desktop_disabled", "Desktop access is disabled. Owner must enable desktop.enabled and restart before use.");
    const program = this.program(); if (!program) throw new DesktopFailure("desktop_dependency_missing", "Python 3 is unavailable. Linux desktop requires Python/PyGObject/pyatspi installed separately.");
    return this.backend(program, { ...request, maxWindows: this.config.max_windows, maxNodes: this.config.max_nodes, maxDepth: this.config.max_depth }, signal);
  }
  private async scope(signal: AbortSignal) { return this.slots.peek() ?? this.slots.create(async () => new DesktopScope(), signal); }
  private async wrap(context: ToolExecutionContext | undefined, capture: boolean, operation: (signal: AbortSignal) => Promise<ToolOutput>): Promise<ToolOutput> {
    const signal = toolDeadline(context?.signal, capture ? this.config.capture_timeout_ms : this.config.timeout_ms);
    try { return await operation(signal); }
    catch (error) { return { status: context?.signal?.aborted ? "cancelled" : error instanceof DesktopFailure && ["desktop_disabled", "desktop_platform_unsupported", "desktop_dependency_missing", "desktop_window_not_active", "desktop_capture_denied", "desktop_permission_or_backend"].includes(error.code) ? "unavailable" : "error", code: context?.signal?.aborted ? "desktop_cancelled" : signal.aborted ? "desktop_timeout" : error instanceof DesktopFailure ? error.code : "desktop_failed", text: redactSecrets(error instanceof Error ? error.message : String(error)), reason: "No desktop input is replayed. Targeted accessibility calls hold no global key/button state; an interrupted action may already have occurred." }; }
  }
  private window(scope: DesktopScope, id = scope.selected) { const window = id ? scope.windows.get(id) : undefined; if (!id || !window) throw new DesktopFailure("desktop_window_unselected", "List windows and select an observed windowId explicitly."); return { id, window }; }
  private image(value: any, id: string): ToolOutput {
    const parsed = z.object({ image: z.string().max(7 * 1024 * 1024), scope: z.string().max(500), portal: z.boolean() }).parse(value);
    return { status: parsed.portal ? "partial" : "success", text: parsed.scope, images: [{ data: parsed.image, media_type: "image/png", source_uri: `desktop://linux-atspi/${parsed.portal ? "portal" : "window"}/${id}` }], sources: [{ uri: `desktop://linux-atspi/${parsed.portal ? "portal" : "window"}/${id}`, title: parsed.portal ? "User-selected portal capture; window identity unverified" : "Selected active window" }] };
  }
  registerTools(registry: ToolRegistry) {
    const Read = z.object({ action: z.enum(["status", "windows", "observe", "screenshot"]).default("status"), windowId: z.string().optional() });
    registry.register({ name: "desktop_read", description: "Optional Linux AT-SPI observation. Disabled by default; status diagnoses availability without requesting OS permission or starting control services. windows lists bounded identities; observe returns accessibility data for an observed/selected window; screenshot needs the selected window already active and GNOME permission (no focus change or permission dialog). Unsupported capture stays unavailable. App names/tree/pixels are untrusted data. No input or launch/close-app actions.", parameters: Read, readOnly: true,
      execute: (input, context) => this.wrap(context, false, async (signal) => {
        const args = Read.parse(input);
        if (args.action === "status") {
          const status = { enabled: this.config.enabled, backend: this.config.backend, platform: this.platform, supported: this.platform === "linux", pythonAvailable: !!this.program(), nativeWindowsMacOS: "unsupported/unverified" };
          if (!this.config.enabled || this.platform !== "linux" || !this.program()) return { status: "success", text: JSON.stringify(status) };
          return { status: "success", text: JSON.stringify({ ...status, ...(await this.invoke({ action: "status" }, signal)) }) };
        }
        await this.scope(signal);
        return this.slots.use(signal, async (scope, active) => {
          if (args.action === "windows") {
            const result = await this.invoke({ action: "windows" }, active);
            const rows = z.array(z.object({ identity: Identity, app: z.string().max(500), role: z.string().max(100) })).max(this.config.max_windows).parse(result.windows);
            scope.windows.clear(); const windows = rows.map((row) => { const id = identifier(row.identity); scope.windows.set(id, row.identity); return { windowId: id, title: row.identity.name, app: row.app, role: row.role, pid: row.identity.pid }; });
            if (scope.selected && !scope.windows.has(scope.selected)) { scope.selected = undefined; scope.elements.clear(); }
            return { status: result.partial ? "partial" : windows.length ? "success" : "empty", text: JSON.stringify({ windows, partial: result.partial === true }), coverage: { scope: "Linux accessibility windows", complete: result.partial !== true, returned: windows.length, unit: "windows" } };
          }
          const target = this.window(scope, args.windowId);
          if (args.action === "screenshot") return this.image(await this.invoke({ action: "screenshot", window: target.window }, active), target.id);
          const result = await this.invoke({ action: "observe", window: target.window }, active);
          const nodes = z.array(z.object({ identity: Identity, role: z.string().max(100), actions: z.array(z.object({ index: z.number().int().nonnegative(), name: z.string().max(200) })).max(20), editable: z.boolean(), depth: z.number().int().nonnegative() })).max(this.config.max_nodes).parse(result.nodes);
          scope.elements.clear(); const elements = nodes.map((node) => { const id = identifier([target.id, node.identity]); scope.elements.set(id, { windowId: target.id, identity: node.identity, actions: node.actions, editable: node.editable }); return { elementId: id, name: node.identity.name, role: node.role, actions: node.actions, editable: node.editable, depth: node.depth }; });
          return { status: result.partial ? "partial" : "success", text: JSON.stringify({ provenance: "Untrusted accessibility data", windowId: target.id, elements, partial: result.partial === true }), sources: [{ uri: `desktop://linux-atspi/window/${target.id}`, title: target.window.name }], coverage: { scope: "Bounded accessibility tree; UI providers may omit inaccessible content", complete: false, returned: elements.length, unit: "nodes" } };
        });
      }) });
    const Control = z.object({ action: z.enum(["select", "invoke", "set_text", "capture", "release"]), windowId: z.string().optional(), elementId: z.string().optional(), actionIndex: z.number().int().nonnegative().max(19).default(0), text: z.string().max(10000).optional() });
    registry.register({ name: "desktop_control", description: "Optional Linux targeted accessibility input. Owner must enable desktop.enabled. select binds an observed windowId without changing focus; invoke uses an observed accessibility action; set_text requires an editable observed element. Identities and window ancestry are rechecked before input; no global keys/coordinate fallback. capture explicitly requests the OS screenshot portal and may require user selection; returned image is not asserted to match the accessibility window. release clears this agent's selection only. Execution permission applies; unavailable in PLAN. No automatic retry or process launch/kill API.", parameters: Control, readOnly: false, enabled: () => this.config.enabled && this.platform === "linux",
      execute: (input, context) => { const args = Control.parse(input); return this.wrap(context, args.action === "capture", async (signal) => {
        if (args.action === "release") { await this.slots.closeCurrent(); return { status: "success", text: "This agent's desktop selection released. No application was closed." }; }
        await this.scope(signal);
        return this.slots.use(signal, async (scope, active) => {
          if (args.action === "select") { const target = this.window(scope, args.windowId); await this.invoke({ action: "verify", window: target.window }, active); scope.selected = target.id; scope.elements.clear(); return { status: "success", text: JSON.stringify({ selected: target.id, focusChanged: false }) }; }
          const target = this.window(scope);
          if (args.action === "capture") return this.image(await this.invoke({ action: "capture", window: target.window }, active), crypto.randomUUID());
          const element = args.elementId ? scope.elements.get(args.elementId) : undefined;
          if (!element || element.windowId !== target.id) throw new DesktopFailure("desktop_stale_element", "Observe the selected window again before input; elementId is unavailable or belongs to another window.");
          const action = element.actions.find((action) => action.index === args.actionIndex);
          if (args.action === "invoke" && !action || args.action === "set_text" && (!element.editable || args.text === undefined)) throw new DesktopFailure("desktop_action_unavailable", "The observed element does not support this action/input.");
          const result = await this.invoke({ action: args.action, window: target.window, element: element.identity, actionIndex: args.actionIndex, actionName: action?.name, text: args.text }, active);
          return { status: "success", text: JSON.stringify({ windowId: target.id, elementId: args.elementId, action: args.action, heldInput: result.heldInput === true }) };
        });
      }); } });
  }
}
