export interface ToolDisplay {
  label: string;
  detail?: string;
}

const LABELS: Record<string, string> = {
  read_file: "Reading file",
  read_document: "Reading document",
  read_skeleton: "Reading code skeleton",
  hash_edit: "Editing file",
  create_file: "Creating file",
  delete_file: "Deleting file",
  move_file: "Moving file",
  apply_unified_patch: "Applying patch",
  glob_files: "Finding files",
  grep_search: "Searching code",
  bash: "Running command",
  web_search: "Searching the web",
  web_fetch: "Fetching page",
  skill: "Loading skill",
  skill_list: "Listing skills",
  todo_write: "Updating plan",
  todo_read: "Reading plan",
  task_create: "Creating task",
  task_dispatch: "Dispatching tasks",
  task_list: "Listing tasks",
  task_cancel: "Cancelling task",
  task_merge: "Merging task",
  task_wait: "Waiting for task",
  spawn_subagents: "Starting subagent",
  bg_start: "Starting background process",
  bg_logs: "Reading background logs",
  bg_list: "Listing background processes",
  bg_stop: "Stopping background process",
  diagnostics_check: "Checking diagnostics",
  inspect_image: "Inspecting image",
  json_query: "Querying JSON",
  diff_view: "Viewing diff",
  repo_map: "Mapping repository",
  repo_architecture_map: "Mapping architecture",
  lsp_workspace_symbols: "Searching symbols",
  lsp_hover_type: "Inspecting type",
  symbol_impact_analysis: "Analyzing impact",
  debug_session: "Debugging session",
  run_sandbox_script: "Running sandbox script",
  remember_insight: "Updating memory",
  recall_insights: "Reading memory",
  question: "Asking a question",
};

export function humanizeToolName(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function toolDisplay(name: string, args: Record<string, unknown> = {}): ToolDisplay {
  const label = LABELS[name] ?? humanizeToolName(name);
  const detail = detailFor(name, args);
  return detail ? { label, detail: truncate(detail, 72) } : { label };
}

function detailFor(name: string, args: Record<string, unknown>): string | undefined {
  switch (name) {
    case "read_file":
    case "read_document":
    case "read_skeleton":
    case "hash_edit":
    case "create_file":
    case "delete_file":
    case "move_file":
    case "apply_unified_patch":
    case "diff_view":
    case "json_query":
    case "inspect_image":
    case "lsp_hover_type":
      return stringArg(args, "filePath", "path", "sourcePath", "destinationPath", "imagePath");
    case "grep_search":
    case "glob_files":
    case "lsp_workspace_symbols":
      return stringArg(args, "pattern", "query");
    case "bash":
    case "run_sandbox_script":
      return stringArg(args, "command");
    case "web_search":
      return stringArg(args, "query");
    case "web_fetch": {
      const url = stringArg(args, "url");
      return url ? hostOf(url) : undefined;
    }
    case "skill":
    case "task_create":
    case "task_cancel":
    case "task_merge":
    case "task_wait":
      return stringArg(args, "id", "name", "taskId", "title", "task");
    case "spawn_subagents":
      return stringArg(args, "task", "description");
    case "bg_start":
      return stringArg(args, "command");
    case "bg_logs":
    case "bg_stop":
      return stringArg(args, "processId", "id");
    case "symbol_impact_analysis":
      return stringArg(args, "symbol", "name");
    default:
      return undefined;
  }
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3).trimEnd()}...` : text;
}
