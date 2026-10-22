import type { AgentMode } from "../types/schema";
import { modeContract } from "./modes";

export const PLAN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "glob_files",
  "grep_search",
  "diff_view",
  "json_query",
  "bash",
  "todo_read",
  "web_search",
  "web_fetch",
  "skill",
  "skill_list",
  "question",
  "diagnostics_check",
  "inspect_image",
]);

export const BUILD_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "hash_edit",
  "create_file",
  "delete_file",
  "move_file",
  "apply_unified_patch",
  "glob_files",
  "grep_search",
  "bash",
  "todo_write",
  "todo_read",
  "web_search",
  "web_fetch",
  "skill",
  "skill_list",
  "question",
  "diagnostics_check",
  "inspect_image",
  "bg_start",
  "bg_logs",
  "bg_list",
  "bg_stop",
  "spawn_subagents",
  "task_create",
  "task_list",
  "task_wait",
  "task_dispatch",
  "task_cancel",
  "task_merge",
]);

export function filterToolsForMode<T extends { name: string }>(
  tools: readonly T[],
  mode: AgentMode,
): T[] {
  const policy = modeContract(mode).toolPolicy;
  if (policy === "all") return [...tools];
  const allowed = policy === "read-only" ? PLAN_TOOL_NAMES : BUILD_TOOL_NAMES;
  return tools.filter((tool) => allowed.has(tool.name));
}
