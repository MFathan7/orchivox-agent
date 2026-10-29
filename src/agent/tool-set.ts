import type { AgentMode } from "../types/schema";
import { modeContract } from "./modes";

export const PLAN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "read_document",
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
  "spawn_subagents",
  "write_plan",
]);

export const BUILD_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "read_document",
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
  if (policy === "all") {
    return tools.filter((tool) => !PLAN_ONLY_TOOL_NAMES.has(tool.name));
  }
  const allowed = policy === "read-only" ? PLAN_TOOL_NAMES : BUILD_TOOL_NAMES;
  return tools.filter((tool) => allowed.has(tool.name));
}

/** Tools that only make sense in plan mode, even when ultrawork sees every tool. */
export const PLAN_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(["write_plan"]);

/**
 * Read-only tools that depend on nothing another tool in the same turn writes.
 * Interactive or stateful reads stay out: `question` waits for the user, and
 * `bash` can leave side effects behind even when its intent is read-only.
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "read_document",
  "read_skeleton",
  "repo_map",
  "repo_architecture_map",
  "glob_files",
  "grep_search",
  "diff_view",
  "json_query",
  "lsp_workspace_symbols",
  "lsp_hover_type",
  "symbol_impact_analysis",
  "diagnostics_check",
  "web_search",
  "web_fetch",
  "inspect_image",
  "todo_read",
  "skill_list",
  "task_list",
  "bg_list",
  "bg_logs",
]);

/** Tools whose results may be produced together without changing state. */
export function isConcurrentSafeTool(name: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(name);
}
