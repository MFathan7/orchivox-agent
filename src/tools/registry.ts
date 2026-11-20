import { z } from "zod";

import { freezeDebugEnabled, logFreeze } from "../agent/freeze-debug";
import type { ToolRulePattern } from "../agent/permissions";
import { currentTurnContext, runWithTurnContext } from "../agent/turn-context";
import {
  toolParametersToJsonSchema,
  type AgentMode,
  type JsonSchemaObject,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "../types/schema";
import { resolveWorkspaceArguments } from "./workspace";
import { normalizeToolOutput, ToolResultError } from "./result";
import { ToolArtifactStore } from "./artifacts";
import { ToolOutputSchema, type ToolExecutionOutput, type ToolProgress } from "../types/tool-output";

export interface ToolExecutionContext {
  signal?: AbortSignal;
  onProgress?: (progress: ToolProgress) => void;
}

export type ToolConcurrency = "shared" | "exclusive";

export interface AgentTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny, TOutput extends ToolExecutionOutput = ToolExecutionOutput> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly parametersJsonSchema?: JsonSchemaObject;
  readonly readOnly: boolean;
  readonly enabled?: () => boolean;
  readonly concurrency?: ToolConcurrency | ((args: Record<string, unknown>) => ToolConcurrency);
  execute(args: z.infer<TSchema>, context?: ToolExecutionContext): Promise<TOutput> | TOutput;
}

export function resolveToolConcurrency(tool: AgentTool | undefined, args: Record<string, unknown>): ToolConcurrency {
  try {
    const policy = tool?.concurrency;
    if (typeof policy !== "function") return policy ?? "exclusive";
    const parsed = tool!.parameters.safeParse(resolveWorkspaceArguments(args));
    if (!parsed.success || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) return "exclusive";
    return policy(parsed.data as Record<string, unknown>) === "shared" ? "shared" : "exclusive";
  } catch {
    return "exclusive";
  }
}

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
  feedback?: string;
}

export interface IToolPermissionChecker {
  check(
    tool: { name: string; readOnly: boolean },
    mode: AgentMode,
    args?: Record<string, unknown>,
    rules?: readonly ToolRulePattern[],
    signal?: AbortSignal,
  ): Promise<PermissionDecision> | PermissionDecision;
}

export class ToolPermissionManager implements IToolPermissionChecker {
  check(
    tool: { name: string; readOnly: boolean },
    mode: AgentMode,
    _args?: Record<string, unknown>,
    _rules?: readonly ToolRulePattern[],
  ): PermissionDecision {
    if (mode === "plan" && !tool.readOnly && tool.name !== "write_plan" && tool.name !== "spawn_subagents") {
      return {
        allowed: false,
        reason: `tool "${tool.name}" changes files or state, and plan mode only allows read-only tools`,
      };
    }
    return { allowed: true };
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();
  private readonly aliases = new Map<string, string>();
  private readonly owners = new Map<string, string>();
  private readonly permissions: IToolPermissionChecker;
  private readonly artifactDirectory?: string;

  constructor(options: { permissions?: IToolPermissionChecker; artifactDirectory?: string } = {}) {
    this.permissions = options.permissions ?? new ToolPermissionManager();
    this.artifactDirectory = options.artifactDirectory;
  }

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
    this.owners.delete(name);
    for (const [alias, target] of this.aliases) if (target === name) this.aliases.delete(alias);
  }

  replaceGroup(owner: string, tools: readonly AgentTool[]): void {
    const names = new Set<string>();
    for (const tool of tools) {
      if (names.has(tool.name) || this.tools.has(tool.name) && this.owners.get(tool.name) !== owner) throw new Error(`tool "${tool.name}" is already registered`);
      names.add(tool.name);
    }
    this.unregisterGroup(owner);
    for (const tool of tools) { this.tools.set(tool.name, tool); this.owners.set(tool.name, owner); }
  }

  unregisterGroup(owner: string): void {
    for (const [name, current] of this.owners) if (current === owner) this.unregister(name);
  }

  snapshot(): ReadonlyMap<string, AgentTool> {
    return new Map([...this.tools.values()].map((tool) => [tool.name, {
      ...tool,
      description: tool.description,
      parameters: tool.parameters,
      parametersJsonSchema: tool.parametersJsonSchema,
      execute: tool.execute.bind(tool),
      ...(tool.enabled ? { enabled: tool.enabled.bind(tool) } : {}),
    }]));
  }

  /** Map an old tool name to a canonical tool without exposing it to the model. */
  registerAlias(alias: string, target: string): void {
    if (this.tools.has(alias) || this.aliases.has(alias)) {
      throw new Error(`tool alias "${alias}" collides with a tool or alias`);
    }
    if (!this.tools.has(target)) throw new Error(`tool alias "${alias}" targets unknown tool "${target}"`);
    this.aliases.set(alias, target);
  }

  get(name: string): AgentTool | undefined {
    return (currentTurnContext()?.toolCatalog ?? this.tools).get(this.aliases.get(name) ?? name);
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  list(): AgentTool[] {
    return [...this.tools.values()].filter((tool) => tool.enabled?.() !== false);
  }

  listDefinitions(tools: Iterable<AgentTool> = this.list()): ToolDefinition[] {
    return [...tools].filter((tool) => tool.enabled?.() !== false).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersJsonSchema ?? toolParametersToJsonSchema(tool.parameters),
      strict: false,
      metadata: { concurrency: typeof tool.concurrency === "function" ? "per-call" : tool.concurrency ?? "exclusive" },
    }));
  }

  concurrencyFor(call: ToolCall): ToolConcurrency {
    return resolveToolConcurrency(this.get(call.name), call.arguments);
  }

  async authorize(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<PermissionDecision> {
    const tool = this.get(name);
    if (!tool) return { allowed: false, reason: `unknown tool "${name}"` };
    if (tool.enabled?.() === false) return { allowed: false, reason: `tool "${name}" is disabled by configuration` };
    const turn = currentTurnContext();
    if (turn?.allowedToolNames && !turn.allowedToolNames.has(tool.name)) return { allowed: false, reason: `tool "${name}" is not allowed for this worker` };
    signal?.throwIfAborted();
    return this.permissions.check(tool, turn?.mode ?? "build", args, turn?.toolPermissionRules ?? [], signal);
  }

  async run(
    call: ToolCall,
    mode: AgentMode,
    signal?: AbortSignal,
    permissionRules: readonly ToolRulePattern[] = currentTurnContext()?.toolPermissionRules ?? [],
  ): Promise<ToolResult> {
    const executionStarted = performance.now();
    const root = currentTurnContext()?.workspaceRoot ?? process.cwd();
    const finish = (output: ToolExecutionOutput) => normalizeToolOutput(call.id, output, {
      root, store: new ToolArtifactStore(root, this.artifactDirectory), durationMs: performance.now() - executionStarted,
    });
    if (signal?.aborted) {
      return finish({ status: "cancelled", code: "aborted", text: "tool cancelled" });
    }
    const tool = this.get(call.name);
    if (!tool) {
      return finish({ status: "unavailable", code: "unknown_tool", text: `unknown tool "${call.name}"` });
    }
    if (tool.enabled?.() === false) {
      return finish({ status: "unavailable", code: "disabled", text: `tool "${call.name}" is disabled by configuration` });
    }

    const allowedTools = currentTurnContext()?.allowedToolNames;
    if (allowedTools && !allowedTools.has(tool.name)) {
      return finish({ status: "unavailable", code: "worker_scope", text: `tool "${tool.name}" is not allowed for this worker` });
    }

    const rawArgs = (call.arguments ?? {}) as Record<string, unknown>;
    // Resolve path arguments against the worker workspace, but let permission
    // rules match the path the model wrote.
    const args = resolveWorkspaceArguments(rawArgs);
    let decision: PermissionDecision;
    try { decision = await this.permissions.check(tool, mode, rawArgs, permissionRules, signal); }
    catch (error) { return finish({ status: signal?.aborted ? "cancelled" : "error", code: "permission_check_failed", text: error instanceof Error ? error.message : String(error) }); }
    if (signal?.aborted) {
      return finish({ status: "cancelled", code: "aborted", text: "tool cancelled" });
    }
    if (!decision.allowed) {
      const feedbackPart = decision.feedback ? ` User feedback: ${decision.feedback}` : "";
      return finish({ status: "error", code: "permission_denied", text: (decision.reason ?? `tool "${tool.name}" is not allowed in ${mode} mode`) + feedbackPart });
    }

    const parsed = tool.parameters.safeParse(args);
    if (!parsed.success) {
      return finish({ status: "error", code: "invalid_arguments", text: `invalid arguments for "${tool.name}": ${formatIssues(parsed.error)}` });
    }

    const startedAt = freezeDebugEnabled() ? performance.now() : 0;
    let acceptingProgress = true;
    try {
      const turn = currentTurnContext();
      let usageReported = false;
      const execute = () => tool.execute(resolveWorkspaceArguments(parsed.data), { signal, onProgress: (progress) => {
        if (acceptingProgress && !signal?.aborted) turn?.onToolProgress?.({ id: call.id, name: tool.name, progress });
      } });
      const rawContent = await (turn ? runWithTurnContext({ ...turn, signal, onToolUsage: (usage) => { usageReported = true; turn.onToolUsage?.(usage); } }, execute) : execute());
      acceptingProgress = false;
      const content = typeof rawContent === "string" ? rawContent : ToolOutputSchema.parse(rawContent);
      if (typeof content !== "string" && content.usage && !usageReported) {
        const usage = content.usage;
        turn?.onToolUsage?.({ type: "usage", ...usage, prompt_tokens: usage.prompt_tokens ?? 0, completion_tokens: usage.completion_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0, cost_incomplete: usage.cost_incomplete ?? usage.cost_usd === undefined });
      }
      if (signal?.aborted) {
        return finish({ ...(typeof content === "string" ? { text: content || "tool cancelled" } : content), status: "cancelled", code: "aborted", reason: "Cancellation arrived during execution; completed side effects may remain." });
      }
      if (startedAt > 0) {
        logFreeze("tool", {
          name: call.name,
          ms: Math.round(performance.now() - startedAt),
          ok: true,
        });
      }
      return await finish(content);
    } catch (error) {
      acceptingProgress = false;
      if (startedAt > 0) {
        logFreeze("tool", {
          name: call.name,
          ms: Math.round(performance.now() - startedAt),
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
        });
      }
      if (error instanceof ToolResultError) return finish(signal?.aborted
        ? { ...error.output, status: "cancelled", reason: [error.output.reason, "Cancellation was observed; completed changes may remain."].filter(Boolean).join(" ") }
        : error.output);
      return finish({ status: signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "cancelled" : "error", code: "execution_failed", text: error instanceof Error ? error.message : String(error) });
    } finally { acceptingProgress = false; }
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
}
