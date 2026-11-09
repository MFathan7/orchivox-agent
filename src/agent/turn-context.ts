import { AsyncLocalStorage } from "node:async_hooks";

import type { AgentMode } from "../types/schema";
import type { ToolRulePattern } from "./permissions";

export interface TurnContext {
  mode: AgentMode;
  sessionId?: string;
  /** Worker id when this turn runs inside a subagent. */
  workerId?: string;
  /** Directory tools should treat as the project root, set for isolated workers. */
  workspaceRoot?: string;
  /** Last user text for this turn, used by tools that need the request. */
  userText?: string;
  /** Skills the user invoked explicitly with /skill:<name>. */
  forcedSkills?: string[];
  /** Skills this agent may load. Undefined means every installed skill. */
  allowedSkills?: string[];
  /** all: every skill, listed: allowedSkills only, none: skill tools disabled. */
  skillPolicy?: "all" | "listed" | "none";
  allowedToolNames?: ReadonlySet<string>;
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
