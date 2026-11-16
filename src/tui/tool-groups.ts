import type { ChatToolCallView } from "./app";

const READ_TOOLS = new Set([
  "read_file",
  "read_document",
  "read_database",
  "read_skeleton",
  "diff_view",
  "json_query",
  "inspect_image",
  "read_archive",
  "read_notebook",
]);

const SEARCH_TOOLS = new Set([
  "grep_search",
  "glob_files",
  "lsp_workspace_symbols",
  "symbol_impact_analysis",
  "repo_map",
  "repo_architecture_map",
  "code_find",
  "ast_search",
  "lsp_definition",
  "lsp_references",
  "lsp_hover_type",
]);

const COMMAND_TOOLS = new Set(["shell", "bash", "run_sandbox_script", "execute"]);

export function observationRuns(calls: ChatToolCallView[]): ChatToolCallView[][] {
  const runs: ChatToolCallView[][] = [];
  let current: ChatToolCallView[] | undefined;
  for (const call of calls) {
    if ((READ_TOOLS.has(call.name) || SEARCH_TOOLS.has(call.name)) && !call.command && !call.diff) {
      if (!current) { current = []; runs.push(current); }
      current.push(call);
    } else {
      current = undefined;
      runs.push([call]);
    }
  }
  return runs;
}

export interface ToolActivity {
  reads: ChatToolCallView[];
  searches: ChatToolCallView[];
  commands: ChatToolCallView[];
  others: ChatToolCallView[];
  total: number;
}

export function groupToolCalls(calls: ChatToolCallView[] = []): ToolActivity {
  const activity: ToolActivity = {
    reads: [],
    searches: [],
    commands: [],
    others: [],
    total: 0,
  };

  for (const call of calls) {
    if (READ_TOOLS.has(call.name)) {
      activity.reads.push(call);
    } else if (SEARCH_TOOLS.has(call.name)) {
      activity.searches.push(call);
    } else if (COMMAND_TOOLS.has(call.name)) {
      activity.commands.push(call);
    } else {
      activity.others.push(call);
    }
  }

  activity.total = activity.reads.length + activity.searches.length + activity.commands.length;
  return activity;
}

export function activitySummary(activity: ToolActivity): string {
  const parts: string[] = [];
  if (activity.reads.length > 0) {
    parts.push(`${activity.reads.length} read${activity.reads.length === 1 ? "" : "s"}`);
  }
  if (activity.searches.length > 0) {
    parts.push(`${activity.searches.length} search${activity.searches.length === 1 ? "" : "es"}`);
  }
  if (activity.commands.length > 0) {
    parts.push(
      `${activity.commands.length} command${activity.commands.length === 1 ? "" : "s"}`,
    );
  }
  return parts.join(" · ");
}

export function activityCalls(activity: ToolActivity): ChatToolCallView[] {
  return [...activity.reads, ...activity.searches, ...activity.commands];
}

export function subagentWaitGroups(calls: ChatToolCallView[]): {
  parents: Map<ChatToolCallView, ChatToolCallView>;
  waits: Map<ChatToolCallView, ChatToolCallView[]>;
} {
  const owners = new Map<string, ChatToolCallView>();
  const parents = new Map<ChatToolCallView, ChatToolCallView>();
  const waits = new Map<ChatToolCallView, ChatToolCallView[]>();
  for (const call of calls) {
    if (call.name === "spawn_subagents") {
      for (const id of call.workerIds ?? []) owners.set(id, call);
    } else if (call.name === "task_wait" && call.workerIds?.length) {
      const parent = owners.get(call.workerIds[0]);
      if (!parent || !call.workerIds.every((id) => owners.get(id) === parent)) continue;
      parents.set(call, parent);
      const children = waits.get(parent) ?? [];
      children.push(call);
      waits.set(parent, children);
    }
  }
  return { parents, waits };
}
