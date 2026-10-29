import { z } from "zod";

import type { LLMProvider } from "../provider/router";
import { ChatRequestSchema } from "../types/schema";
import { runGit } from "./git";

export interface CommitResult {
  message: string;
  files: string[];
  commitHash: string;
}

const CommitGroupSchema = z.object({
  message: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
});

const CommitPlanSchema = z.object({
  commits: z.array(CommitGroupSchema).min(1),
});
export type CommitPlan = z.infer<typeof CommitPlanSchema>;

const CONVENTIONAL_COMMIT_PATTERN =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-zA-Z0-9._/-]+\))?!?: [^\s].+$/;

const PLANNER_SYSTEM = [
  "You split a repository's pending changes into atomic git commits.",
  'Reply with JSON only, no prose, shaped like {"commits":[{"message":"...","files":["..."]}]}.',
  "Each message must follow Conventional Commits, for example feat(api): add route.",
  "Group files that belong to the same logical change, and put every changed file in exactly one group.",
].join(" ");

export async function analyzeAndSplitCommits(
  provider: LLMProvider,
  signal?: AbortSignal,
  options: { repoRoot?: string; model?: string; maxTokens?: number } = {},
): Promise<CommitResult[]> {
  const root = options.repoRoot ?? globalThis.process.cwd();
  const status = (await runGit(root, ["status", "--porcelain"])).stdout;
  if (!status.trim()) return [];

  const diff = await readDiff(root);
  const request = ChatRequestSchema.parse({
    model: options.model,
    system: PLANNER_SYSTEM,
    messages: [
      {
        id: "commit-planner",
        role: "user",
        content: [
          {
            type: "text",
            text: `git status --porcelain:\n${status}\ngit diff HEAD:\n${truncate(diff, 60_000)}`,
          },
        ],
      },
    ],
    max_tokens: options.maxTokens ?? 2000,
  });

  let reply = "";
  let streamError: string | undefined;
  for await (const event of provider.streamChat(request, signal)) {
    if (event.type === "token") reply += event.text;
    else if (event.type === "error") streamError = event.message;
  }
  if (streamError) throw new Error(`commit planner failed: ${streamError}`);

  const plan = parsePlan(reply);
  validatePlan(plan, parseChangedFiles(status));

  const results: CommitResult[] = [];
  for (const group of plan.commits) {
    await runGit(root, ["add", "--", ...group.files]);
    await runGit(root, ["commit", "-m", group.message]);
    const commitHash = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    results.push({ message: group.message, files: group.files, commitHash });
  }
  return results;
}

async function readDiff(root: string): Promise<string> {
  const tracked = await runGit(root, ["diff", "HEAD"], { allowFailure: true });
  if (tracked.exitCode === 0) return tracked.stdout;
  return (await runGit(root, ["diff"], { allowFailure: true })).stdout;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... diff truncated after ${limit} characters`;
}

function parseChangedFiles(porcelain: string): string[] {
  const files: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    let path = line.slice(3);
    if (path.includes(" -> ")) path = path.split(" -> ").pop() ?? path;
    if (path.startsWith('"') && path.endsWith('"')) {
      try {
        path = JSON.parse(path) as string;
      } catch {
        path = path.slice(1, -1);
      }
    }
    files.push(path);
  }
  return files;
}

function parsePlan(text: string): CommitPlan {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("commit planner response contained no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch (error) {
    throw new Error(`commit planner returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const plan = CommitPlanSchema.safeParse(parsed);
  if (!plan.success) {
    const issues = plan.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
    throw new Error(`commit planner returned an invalid plan: ${issues.join("; ")}`);
  }
  return plan.data;
}

function validatePlan(plan: CommitPlan, changedFiles: string[]): void {
  const changed = new Set(changedFiles);
  const claimed = new Set<string>();
  for (const group of plan.commits) {
    if (!CONVENTIONAL_COMMIT_PATTERN.test(group.message)) {
      throw new Error(`commit message does not follow Conventional Commits: "${group.message}"`);
    }
    for (const file of group.files) {
      if (!changed.has(file)) {
        throw new Error(`commit group references "${file}", which is not in the pending changes`);
      }
      if (claimed.has(file)) {
        throw new Error(`file "${file}" appears in more than one commit group`);
      }
      claimed.add(file);
    }
  }
  const uncovered = changedFiles.filter((file) => !claimed.has(file));
  if (uncovered.length > 0) {
    throw new Error(`pending changes not covered by any commit group: ${uncovered.join(", ")}`);
  }
}
