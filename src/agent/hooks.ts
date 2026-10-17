import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";

import type { HooksConfig } from "../config/loader";
import type { AgentTool, ToolRegistry } from "../tools/registry";

export type HookPhase = "PreToolUse" | "PostToolUse" | "OnStop";

export interface HookContext {
  phase: HookPhase;
  toolName?: string;
  args?: Record<string, unknown>;
  filePath?: string;
  resultContent?: string;
  isError?: boolean;
}

export interface HookOutcome {
  allowed?: boolean;
  reason?: string;
  notes?: string[];
}

export type HookHandler = (context: HookContext) => HookOutcome | void | Promise<HookOutcome | void>;

export interface PluginDefinition {
  name: string;
  version?: string;
  description?: string;
  tools?: AgentTool[];
  hooks?: Partial<Record<HookPhase, HookHandler[]>>;
}

export interface PluginLoadReport {
  loaded: string[];
  failed: Array<{ file: string; error: string }>;
}

const HOOK_PHASES: HookPhase[] = ["PreToolUse", "PostToolUse", "OnStop"];

const CONFIG_KEYS: Record<HookPhase, keyof HooksConfig> = {
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  OnStop: "on_stop",
};

export class HookRunner {
  private readonly hooksConfig: HooksConfig;
  private readonly pluginsDir: string;
  private readonly cwd: string;
  private readonly handlers = new Map<HookPhase, HookHandler[]>();

  constructor(options: { hooks?: HooksConfig; pluginsDir?: string; cwd?: string } = {}) {
    this.hooksConfig = options.hooks ?? { pre_tool_use: [], post_tool_use: [], on_stop: [] };
    this.pluginsDir = options.pluginsDir ?? `${options.cwd ?? globalThis.process.cwd()}/.agent/plugins`;
    this.cwd = options.cwd ?? globalThis.process.cwd();
    for (const phase of HOOK_PHASES) this.handlers.set(phase, []);
  }

  registerHandler(phase: HookPhase, handler: HookHandler): void {
    this.handlers.get(phase)?.push(handler);
  }

  registerPlugin(definition: PluginDefinition, registry: ToolRegistry): void {
    for (const tool of definition.tools ?? []) registry.register(tool);
    for (const phase of HOOK_PHASES) {
      for (const handler of definition.hooks?.[phase] ?? []) this.registerHandler(phase, handler);
    }
  }

  async loadUserPlugins(registry: ToolRegistry): Promise<PluginLoadReport> {
    const report: PluginLoadReport = { loaded: [], failed: [] };
    let entries: Dirent[];
    try {
      entries = await readdir(this.pluginsDir, { withFileTypes: true });
    } catch {
      return report;
    }
    const files = entries
      .filter((entry) => entry.isFile() && /\.(ts|js|mjs|cjs)$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const file of files) {
      const fullPath = `${this.pluginsDir}/${file}`;
      try {
        const loaded = (await import(fullPath)) as Record<string, unknown>;
        const definition = (loaded.plugin ?? loaded.default) as PluginDefinition | undefined;
        if (!definition || typeof definition.name !== "string") {
          throw new Error("plugin must export `plugin` or `default` as a PluginDefinition with a name");
        }
        this.registerPlugin(definition, registry);
        report.loaded.push(definition.name);
      } catch (error) {
        report.failed.push({ file, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return report;
  }

  runPreToolUse(context: Omit<HookContext, "phase">): Promise<HookOutcome> {
    return this.runPhase("PreToolUse", context);
  }

  runPostToolUse(context: Omit<HookContext, "phase">): Promise<HookOutcome> {
    return this.runPhase("PostToolUse", context);
  }

  runOnStop(context: Omit<HookContext, "phase"> = {}): Promise<HookOutcome> {
    return this.runPhase("OnStop", context);
  }

  private async runPhase(phase: HookPhase, context: Omit<HookContext, "phase">): Promise<HookOutcome> {
    const scoped: HookContext = { ...context, phase };
    const outcome: HookOutcome = { allowed: true, notes: [] };

    for (const hook of this.hooksConfig[CONFIG_KEYS[phase]]) {
      if (context.toolName && !new Bun.Glob(hook.match).match(context.toolName)) continue;
      this.merge(outcome, phase, await this.runCommandHook(hook.command, hook.timeout_ms, scoped));
    }
    for (const handler of this.handlers.get(phase) ?? []) {
      this.merge(outcome, phase, await handler(scoped));
    }
    return outcome;
  }

  private merge(outcome: HookOutcome, phase: HookPhase, result: HookOutcome | void): void {
    if (!result) return;
    if (phase === "PreToolUse" && result.allowed === false) {
      outcome.allowed = false;
      if (!outcome.reason) outcome.reason = result.reason ?? "blocked by a pre tool use hook";
    }
    if (result.notes) outcome.notes?.push(...result.notes);
  }

  private async runCommandHook(command: string, timeoutMs: number | undefined, context: HookContext): Promise<HookOutcome> {
    const timeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000;
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: this.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...collectEnv(),
        ORCHIVOX_HOOK_PHASE: context.phase,
        ORCHIVOX_TOOL_NAME: context.toolName ?? "",
        ORCHIVOX_FILE_PATH: context.filePath ?? "",
      },
    });
    const timeoutSignal = AbortSignal.timeout(timeout);
    const kill = (): void => proc.kill();
    timeoutSignal.addEventListener("abort", kill, { once: true });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    timeoutSignal.removeEventListener("abort", kill);

    if (timeoutSignal.aborted) {
      return { allowed: false, reason: `hook command timed out after ${timeout}ms`, notes: [`hook timed out: ${command}`] };
    }
    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
      return { allowed: false, reason: `hook command failed: ${detail}`, notes: [`hook failed (${command}): ${detail}`] };
    }
    const note = stdout.trim();
    return { allowed: true, notes: note.length > 0 ? [note] : [] };
  }
}

function collectEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(globalThis.process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
