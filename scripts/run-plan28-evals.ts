#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { AgentOrchestrator } from "../src/agent/orchestrator";
import { currentTurnContext } from "../src/agent/turn-context";
import { loadConfig } from "../src/config/loader";
import { RulesLoader } from "../src/memory/rules-loader";
import { MemoryDatabase } from "../src/memory/sqlite";
import { loadModelCatalogSync } from "../src/provider/model-catalog";
import { ProviderRouter } from "../src/provider/router";
import { extractPathReferences } from "./score-plan28-evals";

const repoRoot = resolve(import.meta.dir, "..");

interface TaskDefinition {
  id: string;
  prompt: string;
  mode: "plan" | "build";
}

interface CallRecord {
  workerId?: string;
  name: string;
  args: unknown;
  isError?: boolean;
  result?: string;
  result_paths?: string[];
  result_path_lines?: string[];
}

const READ_ONLY_TASKS: TaskDefinition[] = [
  {
    id: "read-1-coordinator-retry",
    mode: "plan",
    prompt: [
      "Trace how the coordinator retries an invalid WorkPlan.",
      "Report the exact file paths, function names, and the conditions that trigger a retry.",
      "Also report whether the coordinator validates unknown agents and dependency cycles.",
      "Use read-only tools only. Do not edit files, run tests, install packages, or change repository state.",
      "Do not guess. If you cannot verify something, say so.",
    ].join(" "),
  },
  {
    id: "read-2-task-board-limit",
    mode: "plan",
    prompt: [
      "Trace how the task board enforces its task limit.",
      "Report the exact file paths, function names, and whether completed or cancelled tasks count toward the limit.",
      "Also report which test file covers the limit.",
      "Use read-only tools only. Do not edit files, run tests, install packages, or change repository state.",
      "Do not guess. If you cannot verify something, say so.",
    ].join(" "),
  },
  {
    id: "read-3-fatal-rm",
    mode: "plan",
    prompt: [
      "Trace how the permission engine detects a fatal rm command.",
      "Report the exact file paths, helper function names, and the system roots that are considered fatal.",
      "Also report which test file covers this guard.",
      "Use read-only tools only. Do not edit files, run tests, install packages, or change repository state.",
      "Do not guess. If you cannot verify something, say so.",
    ].join(" "),
  },
  {
    id: "read-4-skill-access",
    mode: "plan",
    prompt: [
      "Trace how skill access is filtered for a specialist agent.",
      "Report the exact file paths, functions, and config fields for skills, skillPolicy, and preloadSkills.",
      "Also report how per-task skills narrow the allowlist.",
      "Use read-only tools only. Do not edit files, run tests, install packages, or change repository state.",
      "Do not guess. If you cannot verify something, say so.",
    ].join(" "),
  },
  {
    id: "read-5-structured-output",
    mode: "plan",
    prompt: [
      "Trace how structured output is sent to a provider for a subagent.",
      "Report the exact request fields, the capability check, the temperature used, and the fallback when structured output is unsupported.",
      "Also report which integration test covers this.",
      "Use read-only tools only. Do not edit files, run tests, install packages, or change repository state.",
      "Do not guess. If you cannot verify something, say so.",
    ].join(" "),
  },
];

function stripAntislop(text: string): string {
  return text
    .replace(/<!--\s*antislop:start\s*-->[\s\S]*?<!--\s*antislop:end\s*-->/gi, "")
    .replace(/^.*antislop.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

class EvalRulesLoader extends RulesLoader {
  override async getGlobalRules(): Promise<string> {
    return stripAntislop(await super.getGlobalRules());
  }

  override async getRulesForFile(targetFilePath: string): Promise<string> {
    return stripAntislop(await super.getRulesForFile(targetFilePath));
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function makeEvalRoot(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, "-");
  const evalRoot = resolve("/tmp/opencode", `plan28-eval-${safe}`);
  rmSync(evalRoot, { recursive: true, force: true });
  mkdirSync(evalRoot, { recursive: true });
  const command = [
    "tar",
    "--exclude=./node_modules",
    "--exclude=./.git",
    "--exclude=./docs/evals",
    "--exclude=./.orchivox",
    "--exclude=./.agent",
    "--exclude=node_modules",
    "--exclude=.git",
    "--exclude=docs/evals",
    "--exclude=.orchivox",
    "--exclude=.agent",
    "-cf",
    "-",
    ".",
    "|",
    "tar",
    "-xf",
    "-",
    "-C",
    shellQuote(evalRoot),
  ].join(" ");
  const result = Bun.spawnSync(["/bin/bash", "-lc", command], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `failed to create eval worktree: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`,
    );
  }
  for (const name of ["docs/evals", ".git", ".agent", ".orchivox", "node_modules"]) {
    rmSync(resolve(evalRoot, name), { recursive: true, force: true });
  }
  const nodeModules = resolve(repoRoot, "node_modules");
  if (existsSync(nodeModules)) {
    symlinkSync(nodeModules, resolve(evalRoot, "node_modules"), "dir");
  }
  return evalRoot;
}

function rewriteRoots<T>(value: T, from: string, to: string): T {
  if (typeof value === "string") return value.split(from).join(to) as T;
  if (Array.isArray(value)) return value.map((entry) => rewriteRoots(entry, from, to)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewriteRoots(entry, from, to)]),
    ) as T;
  }
  return value;
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function commitHash(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "unknown";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const agent = argValue(args, "--agent") ?? "programmer";
  const arm = argValue(args, "--arm") ?? "off";
  const tasksKind = argValue(args, "--tasks") ?? "read-only";
  const runs = Number(argValue(args, "--runs") ?? "1");
  const runId = argValue(args, "--run-id") ?? `plan28-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const orderSeed = Number(argValue(args, "--order-seed") ?? "1");
  const out = resolve(repoRoot, argValue(args, "--out") ?? "docs/evals/plan28/baseline/read-only.jsonl");

  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`--runs must be a positive integer, got ${runs}`);
  }
  if (arm !== "off") {
    throw new Error("only --arm off is implemented; the pilot flag is not built yet");
  }
  if (tasksKind !== "read-only") {
    throw new Error(`task set "${tasksKind}" is not configured yet; read-only is available`);
  }

  const config = await loadConfig("/home/fathan/.orchivox/config.yaml", process.env, {
    secretsPath: "/home/fathan/.orchivox/secrets.yaml",
  });
  const router = new ProviderRouter(config, { catalog: loadModelCatalogSync() });
  const mainRef = router.getRole("main");
  const provider = mainRef?.provider ?? "iForte-GPU";
  const model = mainRef?.model ?? "glm-5.3-flash";
  const caps = router.capabilitiesFor(provider, model);
  const maxOutput = Math.min(caps.max_output ?? 32_000, 256_000);
  const maxTokens = Math.max(1024, maxOutput);
  const sampling = {
    provider,
    model,
    temperature: null,
    top_p: null,
    max_tokens: maxTokens,
    reasoning_effort: caps.reasoning ? "medium" : null,
    seed: null,
    response_format: null,
    run_count: runs,
    order_seed: orderSeed,
    protocol_commit: commitHash(),
    fixture_commit: null,
    skills_disabled: true,
    project_rules_sanitized: true,
  };

  const database = new MemoryDatabase(":memory:");
  const evalRoot = makeEvalRoot(runId);
  const orchestrator = new AgentOrchestrator({
    router,
    worktrees: {} as never,
    snapshots: {} as never,
    rules: new EvalRulesLoader({ rootPath: evalRoot }),
    database,
    config,
    repoRoot: evalRoot,
    maxTurns: 1,
  });
  await orchestrator.initialize();

  // Tool implementations resolve relative paths against the process cwd unless
  // a worker worktree is set. The eval copy becomes that cwd so whole-repo
  // greps cannot see the committed eval records.
  const originalCwd = process.cwd();
  process.chdir(evalRoot);

  // Disable skills for the eval agent so project skill instructions do not
  // leak into the role-rules measurement.
  const registry = orchestrator.specialistAgents as unknown as {
    getAgent: (name: string) => Promise<Record<string, unknown> | undefined>;
  };
  const originalGetAgent = registry.getAgent.bind(registry);
  registry.getAgent = async (name: string) => {
    const profile = await originalGetAgent(name);
    if (!profile || String(profile.name).toLowerCase() !== agent.toLowerCase()) return profile;
    return { ...profile, skillPolicy: "none", skills: [], preloadSkills: [] };
  };

  const calls: CallRecord[] = [];
  const toolRegistry = orchestrator.registry as unknown as {
    run: (
      call: { name: string; arguments: unknown },
      mode: unknown,
      signal: unknown,
      rules: unknown,
    ) => Promise<{ content: unknown; is_error?: boolean }>;
  };
  const originalRun = toolRegistry.run.bind(toolRegistry);
  toolRegistry.run = async (call, mode, signal, rules) => {
    const entry: CallRecord = {
      workerId: currentTurnContext()?.workerId,
      name: call.name,
      args: call.arguments,
    };
    try {
      const result = await originalRun(call, mode, signal, rules);
      const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      const truncated = text.length > 2048 ? `${text.slice(0, 2048)}...[truncated]` : text;
      entry.isError = result.is_error === true;
      entry.result = truncated;
      const refs = extractPathReferences(text);
      entry.result_paths = refs.paths;
      entry.result_path_lines = refs.pathLines;
      return result;
    } catch (error) {
      entry.isError = true;
      entry.result = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      calls.push(entry);
    }
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "", "utf8");

  const records: Array<Record<string, unknown>> = [];
  for (let run = 1; run <= runs; run += 1) {
    const batch = READ_ONLY_TASKS.map((task) => ({
      id: `p28-r${run}-${task.id}`,
      agent,
      task: task.prompt,
      mode: task.mode,
      writeIsolation: false,
    }));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12 * 60 * 1000);
    let results;
    try {
      const spawned = await orchestrator.subagents.spawnBatch(batch, {
        mode: "parallel",
        signal: controller.signal,
      });
      results = spawned.results;
    } finally {
      clearTimeout(timeout);
    }

    for (const [index, result] of results.entries()) {
      const task = READ_ONLY_TASKS[index];
      const worker = orchestrator.subagents.getWorker(result.id);
      const output = rewriteRoots(result.output ?? "", evalRoot, repoRoot);
      const stopped = /subagent stopped after \d+ turns/i.test(output);
      records.push({
        run_id: `${runId}-r${run}`,
        run_index: run,
        task_id: task.id,
        arm,
        agent,
        model,
        provider,
        mode: task.mode,
        sampling,
        state: stopped ? "stopped_40_turns" : result.state,
        task: task.prompt,
        output,
        calls: rewriteRoots(
          calls.filter((call) => call.workerId === result.id),
          evalRoot,
          repoRoot,
        ),
        transcript: rewriteRoots(worker?.transcript ?? [], evalRoot, repoRoot),
        usage: result.usage ?? null,
        files_changed: rewriteRoots(result.files_changed ?? [], evalRoot, repoRoot),
        diff: rewriteRoots(result.diff ?? null, evalRoot, repoRoot),
        duration_ms:
          result.started_at !== undefined && result.finished_at !== undefined
            ? result.finished_at - result.started_at
            : null,
        in_protocol_task_set: true,
        notes: stopped ? "40-turn stop; counted as failed" : "",
      });
    }

    for (const record of records.slice(-results.length)) {
      appendFileSync(out, JSON.stringify(record) + "\n", "utf8");
    }
    console.error(`run ${run}/${runs}: ${results.length} tasks`);
  }

  console.error(`wrote ${records.length} records to ${out}`);
  await orchestrator.stopAllWorkers();
  database.close();
  process.chdir(originalCwd);
  if (!args.includes("--keep-worktree")) {
    rmSync(evalRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
