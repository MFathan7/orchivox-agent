import { z } from "zod";

import {
  toolParametersToJsonSchema,
  type AgentMode,
  type JsonSchemaObject,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "../types/schema";
import { resolveWorkspaceArguments } from "./workspace";

export interface AgentTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly parametersJsonSchema?: JsonSchemaObject;
  readonly readOnly: boolean;
  execute(args: z.infer<TSchema>): Promise<string> | string;
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
  ): Promise<PermissionDecision> | PermissionDecision;
}

export class ToolPermissionManager implements IToolPermissionChecker {
  check(
    tool: { name: string; readOnly: boolean },
    mode: AgentMode,
    _args?: Record<string, unknown>,
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
  private readonly permissions: IToolPermissionChecker;

  constructor(options: { permissions?: IToolPermissionChecker } = {}) {
    this.permissions = options.permissions ?? new ToolPermissionManager();
  }

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  listDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersJsonSchema ?? toolParametersToJsonSchema(tool.parameters),
      strict: false,
      metadata: {},
    }));
  }

  async run(call: ToolCall, mode: AgentMode): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { tool_call_id: call.id, content: `unknown tool "${call.name}"`, is_error: true };
    }

    const rawArgs = (call.arguments ?? {}) as Record<string, unknown>;
    // Resolve path arguments against the worker workspace, but let permission
    // rules match the path the model wrote.
    const args = resolveWorkspaceArguments(rawArgs);
    const decision = await this.permissions.check(tool, mode, rawArgs);
    if (!decision.allowed) {
      const feedbackPart = decision.feedback ? ` User feedback: ${decision.feedback}` : "";
      return {
        tool_call_id: call.id,
        content: (decision.reason ?? `tool "${tool.name}" is not allowed in ${mode} mode`) + feedbackPart,
        is_error: true,
      };
    }

    const parsed = tool.parameters.safeParse(args);
    if (!parsed.success) {
      return {
        tool_call_id: call.id,
        content: `invalid arguments for "${tool.name}": ${formatIssues(parsed.error)}`,
        is_error: true,
      };
    }

    try {
      const content = await tool.execute(resolveWorkspaceArguments(parsed.data));
      return { tool_call_id: call.id, content, is_error: false };
    } catch (error) {
      return {
        tool_call_id: call.id,
        content: error instanceof Error ? error.message : String(error),
        is_error: true,
      };
    }
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
}
