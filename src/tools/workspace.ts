import { isAbsolute, resolve } from "node:path";

import { currentTurnContext } from "../agent/turn-context";

/**
 * The directory a tool should treat as its project. A subagent turn carries its
 * git worktree here; every other turn falls back to the process root.
 */
export function workspaceRoot(fallback: string): string {
  return currentTurnContext()?.workspaceRoot ?? fallback;
}

/** Arguments that name a path the model may write relative to its workspace. */
const PATH_ARGUMENT_KEYS = new Set([
  "filePath",
  "basePath",
  "destinationPath",
  "imagePath",
  "rootPath",
  "cwd",
]);

/**
 * Resolves relative path arguments against the worker workspace. Outside a
 * worker turn the arguments pass through untouched. Absolute paths are left
 * alone so a worker can still read shared files outside its worktree.
 */
export function resolveWorkspaceArguments<T>(args: T): T {
  const root = currentTurnContext()?.workspaceRoot;
  if (!root || typeof args !== "object" || args === null) return args;
  const next: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const key of PATH_ARGUMENT_KEYS) {
    const value = next[key];
    if (typeof value === "string" && value.length > 0 && !isAbsolute(value)) {
      next[key] = resolve(root, value);
    }
  }
  return next as T;
}
