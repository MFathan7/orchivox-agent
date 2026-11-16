import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { DebugConfigSchema, type DebugConfig } from "../config/loader";
import { DapClient } from "../ide/dap-client";
import { redactSecrets } from "../security/secrets";
import type { ToolOutput } from "../types/tool-output";
import { workspaceRoot } from "./workspace";
import { ToolSessionSlots, toolDeadline } from "./session-runtime";
import type { ToolRegistry, ToolExecutionContext } from "./registry";

const Read = z.object({ action: z.enum(["status", "threads", "stack_trace", "variables", "output"]).default("status"), frameId: z.number().int().nonnegative().optional() });
const Write = z.object({ action: z.enum(["start", "launch", "attach", "set_breakpoint", "set_breakpoints", "continue", "next", "step_in", "stack_trace", "variables", "terminate", "disconnect"]),
  adapter: z.string().optional(), program: z.string().optional(), programArgs: z.array(z.string()).max(100).optional(), cwd: z.string().optional(), stopOnEntry: z.boolean().default(true), processId: z.number().int().positive().optional(),
  breakpoints: z.array(z.object({ file: z.string(), lines: z.array(z.number().int().positive()).max(100) })).max(20).default([]),
  file: z.string().optional(), line: z.number().int().positive().optional(), lines: z.array(z.number().int().positive()).max(100).optional(), frameId: z.number().int().nonnegative().optional(),
});
export class DebugTools {
  private readonly config: DebugConfig;
  private readonly slots: ToolSessionSlots<DapClient>;
  constructor(config?: DebugConfig) { this.config = config ?? DebugConfigSchema.parse({}); this.slots = new ToolSessionSlots(this.config.max_sessions, this.config.idle_seconds * 1000); }
  stopForWorker(worker: string) { return this.slots.stopForWorker(worker); }
  dispose() { return this.slots.dispose(); }
  private adapters() { return Object.entries(this.config.adapters).map(([name, adapter]) => ({ name, transport: adapter.command ? "stdio" : "tcp", executableAvailable: adapter.command ? !!(Bun.which(adapter.command) ?? (existsSync(adapter.command) ? adapter.command : undefined)) : undefined, attachConfigured: adapter.attach !== undefined })); }
  private async wrap(context: ToolExecutionContext | undefined, operation: (signal: AbortSignal) => Promise<ToolOutput>): Promise<ToolOutput> {
    const signal = toolDeadline(context?.signal, this.config.timeout_ms);
    try { return await operation(signal); }
    catch (error) {
      return { status: context?.signal?.aborted ? "cancelled" : "error", code: context?.signal?.aborted ? "debug_cancelled" : signal.aborted ? "debug_timeout" : "debug_failed", text: redactSecrets(error instanceof Error ? error.message : String(error)), reason: "Debug execution was not replayed. Inspect state before repeating an interrupted command." };
    }
  }
  registerTools(registry: ToolRegistry) {
    registry.register({ name: "debug_read", description: "Inspect this agent/workspace's explicitly started DAP session. status lists configured adapter dependencies without connecting. threads/output inspect current adapter data; stack_trace/variables require a stopped event. No launch, attach, evaluation or execution. Results are bounded debuggee data.", parameters: Read, readOnly: true,
      execute: (input, context) => this.wrap(context, async (signal) => {
        const args = Read.parse(input);
        if (args.action === "status") return { status: "success", text: JSON.stringify({ state: this.slots.peek()?.state ?? (this.slots.starting() ? "connecting" : "disconnected"), ownership: this.slots.peek()?.kind, adapters: this.adapters(), capabilities: this.slots.peek()?.capabilities ?? {} }) };
        return this.slots.use(signal, async (client, active) => {
          const value = args.action === "threads" ? await client.threads(active) : args.action === "stack_trace" ? await client.frames(active) : args.action === "variables" ? await client.inspectVariables(args.frameId, active) : { output: client.output, partial: client.outputTruncated };
          return { status: !Array.isArray(value) && value.partial ? "partial" : "success", text: JSON.stringify({ state: client.state, value }), coverage: { scope: "DAP inspection: at most 20 frames, 10 scopes, 100 variables/scope, 50000 output characters", complete: false } };
        });
      }) });
    registry.register({ name: "debug_session", description: "Control a configured DAP adapter scoped to this session/agent/workspace. start/launch executes program with literal programArgs; attach uses only owner-configured adapter.attach and optional processId. Start can set initial breakpoints. set_breakpoints replaces a file's lines (empty removes). continue/next/step_in require stopped state. terminate only applies to launches; disconnect preserves attached processes. Execution permissions apply; unavailable in PLAN. No arbitrary adapter commands, evaluation, or automatic retries.", parameters: Write, readOnly: false,
      execute: (input, context) => this.wrap(context, async (signal) => {
        const args = Write.parse(input);
        if (args.action === "disconnect") { await this.slots.closeCurrent(); return { status: "success", text: "Adapter disconnected. Attached debuggees were preserved; owned launches were asked to terminate." }; }
        if (args.action === "start" || args.action === "launch" || args.action === "attach") {
          if (!args.adapter || !this.config.adapters[args.adapter]) return { status: "unavailable", code: "debug_adapter_unconfigured", text: "Choose an adapter configured in debug.adapters. Use debug_read status for dependency diagnosis." };
          const adapter = this.config.adapters[args.adapter];
          if (adapter.command && !(Bun.which(adapter.command) ?? (existsSync(adapter.command) ? adapter.command : undefined))) return { status: "unavailable", code: "debug_adapter_missing", text: "Configured debug adapter executable is unavailable. Install/configure it separately." };
          if (args.action === "attach" && adapter.attach === undefined) return { status: "unavailable", code: "debug_attach_unconfigured", text: "Attach requires an owner-defined debug.adapters.<name>.attach configuration." };
          if (args.action !== "attach" && !args.program) throw new Error("launch/start requires program.");
          const root = workspaceRoot(process.cwd());
          const client = await this.slots.create(async (active) => {
            const client = new DapClient({ command: adapter.command, args: adapter.args, env: adapter.env, cwd: args.cwd ? resolve(root, args.cwd) : root, host: adapter.host, port: adapter.port, launchType: adapter.launch_type, timeoutMs: this.config.timeout_ms });
            for (const breakpoint of args.breakpoints) client.configureBreakpoints(resolve(root, breakpoint.file), breakpoint.lines);
            try {
              if (args.action === "attach") await client.attach({ ...adapter.attach, ...(args.processId ? { processId: args.processId } : {}) }, active);
              else await client.start(resolve(root, args.program!), { args: args.programArgs, cwd: args.cwd ? resolve(root, args.cwd) : root, stopOnEntry: args.stopOnEntry, launch: adapter.launch, signal: active });
              return client;
            } catch (error) { await client.close(); throw error; }
          }, signal);
          return { status: "success", text: JSON.stringify({ state: client.state, ownership: client.kind, capabilities: client.capabilities }) };
        }
        return this.slots.use(signal, async (client, active) => {
          let value: unknown;
          if (args.action === "set_breakpoint") { if (!args.file || !args.line) throw new Error("set_breakpoint requires file and line."); value = await client.setBreakpoint(resolve(workspaceRoot(process.cwd()), args.file), args.line, active); }
          else if (args.action === "set_breakpoints") { if (!args.file || !args.lines) throw new Error("set_breakpoints requires file and lines."); value = await client.setBreakpoints(resolve(workspaceRoot(process.cwd()), args.file), args.lines, active); }
          else if (args.action === "continue") value = await client.continueExecution(active);
          else if (args.action === "next") value = await client.next(active);
          else if (args.action === "step_in") value = await client.stepIn(active);
          else if (args.action === "stack_trace") value = await client.frames(active);
          else if (args.action === "variables") value = await client.inspectVariables(args.frameId, active);
          else value = await client.terminate(active);
          return { status: "success", text: JSON.stringify({ state: client.state, value }) };
        });
      }) });
  }
}
