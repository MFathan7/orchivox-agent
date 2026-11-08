#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { extractPathReferences } from "./score-plan28-evals";
import { existsSync } from "node:fs";

const repoRoot = resolve(import.meta.dir, "..");
const stateRoot = "/home/fathan/.local/share/orchivox/projects";

interface RealTaskRecord {
  source: "actual-usage";
  run_id: string;
  task_id: string;
  session_id: string;
  agent: string | null;
  worker_id: string | null;
  mode: string | null;
  state: string | null;
  output: string;
  calls: never[];
  tool_evidence: "unavailable";
  files_changed: string[];
  diff: string | null;
  repo_root: string | null;
  sampling: Record<string, unknown>;
  notes: string;
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function projectRoot(db: Database): string | null {
  const row = db
    .query(
      "SELECT content_json FROM messages WHERE metadata_json LIKE '%\"key\":\"environment\"%' ORDER BY created_at ASC LIMIT 1",
    )
    .get() as { content_json?: string } | null;
  if (!row?.content_json) return null;
  try {
    const content = JSON.parse(row.content_json) as Array<{ text?: string }>;
    const text = content.map((block) => block.text ?? "").join("\n");
    const match = /Working directory:\s*(.+)/.exec(text);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function main(): void {
  const glob = new Glob("**/memory.db");
  const records: RealTaskRecord[] = [];
  const dbs: string[] = [];
  for (const path of glob.scanSync({ cwd: stateRoot, absolute: true })) dbs.push(path);

  for (const path of dbs) {
    let db: Database;
    try {
      db = new Database(path, { readonly: true });
    } catch {
      continue;
    }
    try {
      const root = projectRoot(db);
      const tasks = db
        .query(
          "SELECT id, title, agent, worker_id, mode, state, result, files_changed, diff, updated_at FROM tasks ORDER BY updated_at DESC",
        )
        .all() as Array<Record<string, unknown>>;
      for (const task of tasks) {
        const output = String(task.result ?? "").trim();
        if (!output) continue;
        records.push({
          source: "actual-usage",
          run_id: `real-${String(task.worker_id ?? task.id)}`,
          task_id: String(task.id),
          session_id: String(task.worker_id ?? ""),
          agent: task.agent ? String(task.agent) : null,
          worker_id: task.worker_id ? String(task.worker_id) : null,
          mode: task.mode ? String(task.mode) : null,
          state: task.state ? String(task.state) : null,
          output,
          calls: [],
          tool_evidence: "unavailable",
          files_changed: parseJsonArray(task.files_changed),
          diff: task.diff ? String(task.diff) : null,
          repo_root: root,
          sampling: {
            provider: null,
            model: null,
            temperature: null,
            top_p: null,
            max_tokens: null,
            reasoning_effort: null,
            seed: null,
            response_format: null,
          },
          notes:
            "Historical task table row from actual usage. Tool calls and tool results were not persisted.",
        });
      }
    } finally {
      db.close();
    }
  }

  const out = resolve(repoRoot, "docs/evals/plan28/real/prevalence.jsonl");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""), "utf8");

  let completed = 0;
  let stopped = 0;
  let missingCitations = 0;
  let cited = 0;
  let sessionsWithMissing = 0;
  let sessionsWithVerificationClaim = 0;
  for (const record of records) {
    const output = record.output;
    const isStopped = /subagent stopped after \d+ turns/i.test(output);
    if (isStopped) stopped += 1;
    else completed += 1;
    if (/verif|verified|lulus|pass(ed)?|test suite|build/i.test(output)) {
      sessionsWithVerificationClaim += 1;
    }
    const refs = extractPathReferences(output);
    const root = record.repo_root;
    if (!root) continue;
    const missing = refs.paths.filter((path) => !existsSync(resolve(root, path)));
    cited += refs.paths.length;
    missingCitations += missing.length;
    if (missing.length > 0) sessionsWithMissing += 1;
  }

  console.log(
    JSON.stringify(
      {
        records: records.length,
        completed,
        stopped40Turns: stopped,
        citedPaths: cited,
        missingCitedPaths: missingCitations,
        sessionsWithMissingCitedPath: sessionsWithMissing,
        sessionsWithVerificationClaim,
        note:
          "Primary violation prevalence cannot be computed: tool calls/results are absent from the historical task store.",
      },
      null,
      2,
    ),
  );
}

main();
