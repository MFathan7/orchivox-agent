import { AsyncLocalStorage } from "node:async_hooks";

import type { AgentMode, Usage, UsageEvent } from "../types/schema";
import type { ToolRulePattern } from "./permissions";
import type { ContextCheckpoint } from "./context-checkpoint";
import type { AgentTool } from "../tools/registry";
import type { ToolProgress } from "../types/tool-output";

export interface TurnContext {
  mode: AgentMode;
  signal?: AbortSignal;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  toolCatalog?: ReadonlyMap<string, AgentTool>;
  onToolProgress?: (event: { id: string; name: string; progress: ToolProgress }) => void;
  onToolUsage?: (usage: UsageEvent) => void;
  onToolUsageMissing?: () => void;
  onToolModelRequest?: (request: { provider: string; model: string; startedAt: number; durationMs: number; usage: Usage; retries: number; retryDelayMs: number }) => void;
  consumeNestedTool?: (name: string) => void;
  contextControl?: ContextCheckpoint;
  /** Worker id when this turn runs inside a subagent. */
  workerId?: string;
  /** Directory tools should treat as the project root, set for isolated workers. */
  workspaceRoot?: string;
  /** Last user text for this turn, used by tools that need the request. */
  userText?: string;
  /** Skills the user invoked explicitly with /skill:<name>. */
  forcedSkills?: string[];
  invokedSkills?: ReadonlySet<string>;
  /** Skills this agent may load. Undefined means every installed skill. */
  allowedSkills?: string[];
  /** all: every skill, listed: allowedSkills only, none: skill tools disabled. */
  skillPolicy?: "all" | "listed" | "none";
  allowedToolNames?: ReadonlySet<string>;
  /** Catalog snapshot for dependency diagnosis; it does not grant permission. */
  availableToolNames?: ReadonlySet<string>;
  toolPermissionRules?: readonly ToolRulePattern[];
}

const storage = new AsyncLocalStorage<TurnContext>();

export function runWithTurnContext<T>(context: TurnContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function currentTurnContext(): TurnContext | undefined {
  return storage.getStore();
}

export function currentMode(): AgentMode | undefined {
  return storage.getStore()?.mode;
}
