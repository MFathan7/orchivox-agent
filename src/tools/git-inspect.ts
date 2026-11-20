import { z } from "zod";

import { runToolProcess } from "./process";
import type { AgentTool } from "./registry";

const Args = z.object({
  operation: z.enum(["status", "diff"]),
  staged: z.boolean().default(false).describe("For diff, show staged changes instead of unstaged changes."),
  paths: z.array(z.string().min(1)).max(50).default([]).describe("For diff, select literal paths relative to the workspace. Omit to inspect all changed paths."),
});

export function createGitInspectTool(): AgentTool<typeof Args, string> {
  return {
    name: "git_inspect",
    description: "Inspect Git status or staged/unstaged diffs in the active workspace without shell syntax. Requires Git on PATH.",
    parameters: Args,
    readOnly: true,
    concurrency: "shared",
    async execute(args, context) {
      const git = Bun.which("git");
      if (!git) throw new Error("Git is unavailable. Install Git and restart Orchivox with git on PATH.");
      const command = args.operation === "status"
        ? ["status", "--short", "--untracked-files=normal", "--ignore-submodules=dirty"]
        : ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=dirty", ...(args.staged ? ["--cached"] : []), "--", ...args.paths];
      const result = await runToolProcess([
        git, "--no-pager", "--no-optional-locks", "--literal-pathspecs",
        "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...command,
      ], { signal: context?.signal, env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" } });
      if (result.truncated) return `${result.output}\n[Git output exceeded the tool limit. Narrow the diff by path.]`.trim();
      if (result.code !== 0) throw new Error(result.error.trim() || `Git exited with code ${result.code}.`);
      return result.output || (args.operation === "status" ? "Working tree is clean." : "No changes in the selected diff.");
    },
  };
}
