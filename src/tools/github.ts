import { z } from "zod";
import type { AgentTool, ToolRegistry } from "./registry";
import { runToolProcess, ToolProcessTimeoutError } from "./process";
import type { ToolOutput } from "../types/tool-output";
import { redactSecrets } from "../security/secrets";

const repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).describe("Explicit owner/repository. Uses existing GitHub CLI authentication.");
const readSchema = z.object({ repository: repo,
  operation: z.enum(["repository", "issues", "issue", "pulls", "pull", "pull_diff", "pull_files", "checks", "runs", "run", "code_search", "run_jobs", "run_watch", "run_logs"]),
  query: z.string().min(1).max(2000).optional(),
  timeoutSeconds: z.number().int().min(1).max(120).default(30),
  intervalSeconds: z.number().int().min(1).max(30).default(3),
  number: z.number().int().positive().optional(), page: z.number().int().min(1).max(1000).default(1),
});
const writeSchema = z.object({ repository: repo,
  operation: z.enum(["create_issue", "comment_issue", "create_pull", "comment_pull", "close_issue", "merge_pull"]),
  number: z.number().int().positive().optional(), title: z.string().min(1).max(256).optional(), body: z.string().max(50_000).optional(),
  head: z.string().min(1).optional(), base: z.string().min(1).optional(), draft: z.boolean().optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).default("squash"),
});

export function registerGithubTools(registry: ToolRegistry, program = Bun.which("gh")): void {
  class GithubFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
  const invoke = async (args: string[], signal?: AbortSignal, timeoutMs?: number, input?: string) => {
    if (!program) throw new GithubFailure("github_cli_missing", "GitHub CLI (gh) is unavailable. Install it and sign in outside this tool.");
    const result = await runToolProcess([program, ...args], { signal, timeoutMs, input });
    if (result.code !== 0 && !result.truncated) {
      const http = /HTTP (\d{3})/.exec(result.error)?.[1];
      const code = result.code === 4 || http === "401" ? "github_auth_required" : http === "403" ? "github_access_denied" : http === "404" ? "github_not_found" : http === "429" ? "github_rate_limited" : "github_cli_failed";
      throw new GithubFailure(code, redactSecrets(result.error.trim() || `GitHub CLI exited with ${result.code}.`));
    }
    return result;
  };
  const run = async (endpoint: string, method: string, signal?: AbortSignal, body?: unknown, diff = false): Promise<string> => {
    const args = ["api", endpoint, "--method", method, "--header", `Accept: ${diff ? "application/vnd.github.diff" : "application/vnd.github+json"}`];
    if (body !== undefined) args.push("--input", "-");
    const result = await invoke(args, signal, undefined, body === undefined ? undefined : JSON.stringify(body));
    if (result.truncated) throw new GithubFailure("github_output_incomplete", "GitHub write output exceeded the limit; the operation may have completed. Inspect its state before retrying.");
    return result.output;
  };
  registry.register({
    name: "github_read", description: "Inspect GitHub repositories, issues, PRs/checks and Actions using existing gh authentication. code_search requires repository and query (up to 1000 results, 50/page). run_jobs, run_watch and run_logs require number (run ID); logs include failed steps only. Watch is bounded by timeoutSeconds and reports progress; follow returned continuation. No checkout, login, publication or workflow dispatch.",
    parameters: readSchema, readOnly: true, concurrency: "shared",
    async execute(input, context): Promise<ToolOutput> {
      const args = readSchema.parse(input), root = `repos/${args.repository}`, uri = `https://github.com/${args.repository}`;
      const sources = [{ uri, title: args.repository }];
      try {
        const required = () => { if (!args.number) throw new Error("number (run/issue/PR ID) is required for this operation."); return args.number; };
        const call = (endpoint: string, timeoutMs = args.timeoutSeconds * 1000) => invoke(["api", endpoint, "--method", "GET", "--header", `Accept: ${args.operation === "pull_diff" ? "application/vnd.github.diff" : "application/vnd.github+json"}`], context?.signal, timeoutMs);
        if (args.operation === "run_logs") {
          const number = required();
          const result = await invoke(["run", "view", String(number), "--repo", args.repository, "--log-failed"], context?.signal, args.timeoutSeconds * 1000);
          return { status: result.truncated ? "partial" : result.output.trim() ? "success" : "empty", text: result.output || "No failed-step log text returned; logs may be absent or expired.", sources: [{ uri: `${uri}/actions/runs/${number}`, title: "Failed-step logs" }], truncation: { truncated: result.truncated, reason: "Combined process output is limited to 50000 bytes." } };
        }
        if (args.operation === "run_watch") {
          const number = required(), deadline = Date.now() + args.timeoutSeconds * 1000; let observations = 0, latest: any;
          const output = (status: "success" | "partial"): ToolOutput => ({ status, text: JSON.stringify({ repository: args.repository, run: latest, observations }), data: { repository: args.repository, run: latest ?? null, observations }, sources: [{ uri: `${uri}/actions/runs/${number}`, title: "Workflow run" }], ...(status === "partial" ? { reason: "Watch deadline reached; the workflow may still be running.", continuation: { tool: "github_read", arguments: args, message: "Resume watching explicitly, or read run_logs after failure." } } : {}) });
          for (;;) {
            context?.signal?.throwIfAborted();
            if (Date.now() >= deadline) return output("partial");
            let response;
            try { response = await call(`${root}/actions/runs/${number}`, Math.max(1, deadline - Date.now())); }
            catch (error) { if (error instanceof ToolProcessTimeoutError) return output("partial"); throw error; }
            if (response.truncated) return { status: "partial", text: response.output, sources, truncation: { truncated: true, reason: "Workflow status exceeded process output limit." } };
            latest = JSON.parse(response.output);
            if (typeof latest.status !== "string") throw new Error("Malformed workflow status response.");
            observations++; context?.onProgress?.({ progress: observations, message: `Workflow ${latest.status}${latest.conclusion ? ` · ${latest.conclusion}` : ""}` });
            if (latest.status === "completed") return output("success");
            await pause(Math.min(args.intervalSeconds * 1000, Math.max(0, deadline - Date.now())), context?.signal);
          }
        }
        let endpoint: string;
        if (args.operation === "code_search") {
          if (!args.query) throw new Error("query is required for code_search.");
          if (args.page > 20) throw new Error("GitHub code search exposes at most 1000 results (20 pages); narrow the query.");
          endpoint = `search/code?${new URLSearchParams({ q: `${args.query} repo:${args.repository}`, per_page: "50", page: String(args.page) })}`;
        } else {
          const paths = {
            repository: () => root, issues: () => `${root}/issues`, issue: () => `${root}/issues/${required()}`,
            pulls: () => `${root}/pulls`, pull: () => `${root}/pulls/${required()}`, pull_diff: () => `${root}/pulls/${required()}`,
            pull_files: () => `${root}/pulls/${required()}/files`, checks: () => `${root}/commits/HEAD/check-runs`,
            runs: () => `${root}/actions/runs`, run: () => `${root}/actions/runs/${required()}`, run_jobs: () => `${root}/actions/runs/${required()}/jobs`,
          };
          endpoint = `${paths[args.operation]()}?per_page=50&page=${args.page}`;
        }
        const response = await call(endpoint);
        if (response.truncated) return { status: "partial", text: response.output, sources, truncation: { truncated: true, reason: "Combined process output exceeds 50000 bytes; request a narrower resource." } };
        if (args.operation === "code_search" || args.operation === "run_jobs") {
          const body = JSON.parse(response.output), items = args.operation === "code_search" ? body.items : body.jobs;
          if (!Array.isArray(items) || !Number.isInteger(body.total_count) || body.total_count < 0) throw new Error("Malformed GitHub listing response.");
          const scoped = args.operation === "code_search" ? items.filter((item: any) => item.repository?.full_name?.toLowerCase() === args.repository.toLowerCase()) : items;
          const ceiling = args.operation === "code_search" ? 1000 : 50000;
          const more = args.page * 50 < Math.min(body.total_count, ceiling), partial = body.incomplete_results === true || body.total_count > ceiling || scoped.length !== items.length || more;
          return { status: partial ? "partial" : scoped.length ? "success" : "empty", text: JSON.stringify({ repository: args.repository, items: scoped, total: body.total_count, incomplete: body.incomplete_results === true, excludedForeignResults: items.length - scoped.length }),
            sources, coverage: { scope: args.repository, returned: scoped.length, total: body.total_count, complete: !partial, unit: args.operation === "code_search" ? "files" : "jobs" },
            ...(partial ? { reason: "Results are paginated, backend-incomplete, capped, or excluded for repository mismatch." } : {}),
            continuation: more ? { tool: "github_read", arguments: { ...args, page: args.page + 1 }, message: "Read the next page; live results can change between calls." } : { message: body.total_count > ceiling ? "Backend result cap reached; narrow the query." : "No next page reported." } };
        }
        return { status: "success", text: response.output, sources };
      } catch (error) {
        context?.signal?.throwIfAborted();
        return { status: error instanceof GithubFailure && error.code === "github_cli_missing" ? "unavailable" : "error", code: error instanceof GithubFailure ? error.code : error instanceof ToolProcessTimeoutError ? "github_timeout" : "github_read_failed", text: redactSecrets(error instanceof Error ? error.message : String(error)), sources };
      }
    },
  });
  registry.register({
    name: "github_write", description: "Publish an explicitly authorized GitHub issue, comment or pull request, close an issue, or merge a pull request. Uses existing gh authentication. Review repository/target/content before calling; follows the normal permission flow. No implicit push or workflow dispatch.",
    parameters: writeSchema, readOnly: false, enabled: () => !!program,
    async execute(input, context) {
      const args = writeSchema.parse(input), root = `repos/${args.repository}`;
      const number = () => { if (!args.number) throw new Error("number is required for this operation."); return args.number; };
      if (args.operation === "create_issue") {
        if (!args.title) throw new Error("title is required.");
        return run(`${root}/issues`, "POST", context?.signal, { title: args.title, body: args.body ?? "" });
      }
      if (args.operation === "create_pull") {
        if (!args.title || !args.head || !args.base) throw new Error("title, head, and base are required.");
        return run(`${root}/pulls`, "POST", context?.signal, { title: args.title, head: args.head, base: args.base, body: args.body ?? "", draft: args.draft ?? false });
      }
      if (args.operation === "close_issue") return run(`${root}/issues/${number()}`, "PATCH", context?.signal, { state: "closed" });
      if (args.operation === "merge_pull") return run(`${root}/pulls/${number()}/merge`, "PUT", context?.signal, { merge_method: args.mergeMethod });
      if (!args.body) throw new Error("body is required for a comment.");
      return run(`${root}/issues/${number()}/comments`, "POST", context?.signal, { body: args.body });
    },
  } satisfies AgentTool);
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal?.reason); };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
