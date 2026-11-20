import type { AgentMode } from "../types/schema";
import { modeContract } from "./modes";

export const PLAN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "remote_read",
  "desktop_read",
  "browser_read",
  "debug_read",
  "ast_search",
  "code_find",
  "read_archive",
  "read_notebook",
  "github_read",
  "context_checkpoint",
  "context_rewind",
  "lsp_definition",
  "lsp_references",
  "lsp_hover_type",
  "lsp_workspace_symbols",
  "lsp_code_actions",
  "lsp_preview_file_rename",
  "read_file",
  "read_document",
  "read_database",
  "glob_files",
  "grep_search",
  "diff_view",
  "git_inspect",
  "json_query",
  "shell",
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
  "task_list",
  "task_wait",
  "write_plan",
]);

export const BUILD_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "read_document",
  "read_database",
  "hash_edit",
  "replace_text",
  "create_file",
  "delete_file",
  "move_file",
  "apply_unified_patch",
  "glob_files",
  "grep_search",
  "shell",
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
  "git_inspect",
  "probe_local_http",
  "spawn_subagents",
  "task_create",
  "task_list",
  "task_wait",
  "task_dispatch",
  "task_cancel",
  "task_merge",
  "execute",
  "coordinate",
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
