import { AsyncLocalStorage } from "node:async_hooks";

import type { AgentMode } from "../types/schema";

export interface TurnContext {
  mode: AgentMode;
  sessionId?: string;
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
