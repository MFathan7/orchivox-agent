import { z } from "zod";

import type { AgentTool, ToolRegistry } from "../tools/registry";
import type { JsonSchemaObject, SubagentResult, SubagentState, Usage } from "../types/schema";
import { SubagentResultSchema } from "../types/schema";
import type { AgentMode } from "../types/schema";
import type { WorktreeManager } from "../vcs/worktree";
import { currentTurnContext, runWithTurnContext } from "./turn-context";

export interface SubagentTaskInput {
  workerId: string;
  agent?: string;
  task: string;
  mode?: AgentMode;
  roleModel?: "main" | "fast" | "advisor";
  provider?: string;
  model?: string;
  outputJsonSchema?: JsonSchemaObject;
  writeIsolation: boolean;
  worktreePath?: string;
  signal: AbortSignal;
  onTranscript: (line: string) => void;
  onUsage: (usage: Usage) => void;
  drainSteerings: () => string[];
}

export interface SubagentTaskResult {
  output: string;
  usage?: Usage;
  /** Unified diff produced inside the worker's worktree, when isolated. */
  diff?: string;
  filesChanged?: string[];
  branch?: string;
}

export type SubagentExecutor = (input: SubagentTaskInput) => Promise<SubagentTaskResult>;

export interface SubagentWorkerState {
  id: string;
  agent?: string;
  task: string;
  roleModel?: "main" | "fast" | "advisor";
  provider?: string;
  model?: string;
  status: SubagentState;
  transcript: string[];
  usage?: Usage;
  worktreePath?: string;
  outputJsonSchema?: JsonSchemaObject;
  structuredOutput?: unknown;
  error?: { code: string; message: string };
  result?: SubagentResult;
  createdAt: number;
  updatedAt: number;
}

export type SubagentBatchMode = "parallel" | "chain";

export interface SubagentSpawnTask {
  id?: string;
  agent?: string;
  task: string;
  mode?: AgentMode;
  roleModel?: "main" | "fast" | "advisor";
  provider?: string;
  model?: string;
  outputJsonSchema?: JsonSchemaObject;
  writeIsolation?: boolean;
}

export interface SubagentMergeReport {
  workerId: string;
  merged: boolean;
  summary: string;
}

const WORKER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Upper bound for one parallel batch, so a single call cannot flood the machine. */
const MAX_PARALLEL_SUBAGENTS = 8;

/** How much of the previous worker output a chain step receives. */
const PREVIOUS_RESULT_LIMIT = 12_000;

function interpolatePrevious(task: string, previous: string): string {
  if (!task.includes("{previous}")) return task;
  const value =
    previous.length > PREVIOUS_RESULT_LIMIT
      ? `${previous.slice(0, PREVIOUS_RESULT_LIMIT)}\n\n[... previous result truncated to fit the chain step]`
      : previous;
  return task.split("{previous}").join(value.length > 0 ? value : "(no previous result)");
}
const TRANSCRIPT_LIMIT = 500;

export class SubagentManager {
  private readonly executor: SubagentExecutor;
  private readonly worktrees: WorktreeManager;
  private readonly workers = new Map<string, SubagentWorkerState>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly steerings = new Map<string, string[]>();
  private readonly completions = new Map<string, Promise<void>>();
  private counter = 0;

  constructor(options: { executor: SubagentExecutor; worktrees: WorktreeManager }) {
    this.executor = options.executor;
    this.worktrees = options.worktrees;
  }

  registerTools(registry: ToolRegistry): void {
    registry.register(this.spawnTool());
  }

  listWorkers(): SubagentWorkerState[] {
    return [...this.workers.values()];
  }

  getWorker(workerId: string): SubagentWorkerState | undefined {
    return this.workers.get(workerId);
  }

  spawnOne(input: {
    id?: string;
    agent?: string;
    task: string;
    mode?: AgentMode;
    roleModel?: "main" | "fast" | "advisor";
    provider?: string;
    model?: string;
    outputJsonSchema?: JsonSchemaObject;
    writeIsolation?: boolean;
    onComplete?: (worker: SubagentWorkerState) => void;
  }): SubagentWorkerState {
    this.counter += 1;
    const id = input.id ?? `worker-${Date.now().toString(36)}-${this.counter}`;
    if (!WORKER_ID_PATTERN.test(id)) {
      throw new Error(`invalid worker id "${id}": use letters, digits, dots, underscores, or dashes`);
    }
    if (this.workers.has(id)) throw new Error(`worker "${id}" already exists`);

    let resolvedAgent = input.agent;
    if (!resolvedAgent) {
      const match = /^@([a-zA-Z0-9_-]+)\s+([\s\S]*)$/.exec(input.task.trim());
      if (match) {
        resolvedAgent = match[1];
      }
    }

    const controller = new AbortController();
    const worker: SubagentWorkerState = {
      id,
      agent: resolvedAgent,
      task: input.task,
      roleModel: input.roleModel,
      provider: input.provider,
      model: input.model,
      status: "queued",
      transcript: [],
      outputJsonSchema: input.outputJsonSchema,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.workers.set(id, worker);
    this.controllers.set(id, controller);
    this.steerings.set(id, []);
    const completion = this.runWorker(
      worker,
      { ...input, mode: input.mode ?? currentTurnContext()?.mode ?? "build" },
      controller,
    )
      .catch(() => {
        // runWorker records failures on the worker state
      })
      .finally(() => {
        input.onComplete?.(worker);
      });
    this.completions.set(id, completion);
    return worker;
  }

  async spawn(tasks: SubagentSpawnTask[]): Promise<SubagentResult[]> {
    const batch = await this.spawnBatch(tasks, { mode: "parallel" });
    return batch.results;
  }

  /**
   * Runs a batch of workers. Parallel starts every worker at once; chain runs
   * them one by one and replaces `{previous}` in later tasks with the previous
   * worker output. Chain steps share the working tree unless a task asks for
   * isolation, because a later step depends on the files the earlier one wrote.
   */
  async spawnBatch(
    tasks: SubagentSpawnTask[],
    options: { mode?: SubagentBatchMode; merge?: boolean } = {},
  ): Promise<{ results: SubagentResult[]; merged: SubagentMergeReport[] }> {
    const mode = options.mode ?? "parallel";
    const results: SubagentResult[] = [];

    if (mode === "chain") {
      let previous = "";
      for (const [index, task] of tasks.entries()) {
        const worker = this.spawnOne({
          ...task,
          task: index === 0 ? task.task : interpolatePrevious(task.task, previous),
          writeIsolation: task.writeIsolation ?? false,
        });
        await this.completions.get(worker.id);
        const result = this.resultOf(worker);
        results.push(result);
        previous = result.output;
        if (result.state !== "completed") break;
      }
    } else {
      if (tasks.length > MAX_PARALLEL_SUBAGENTS) {
        throw new Error(
          `too many parallel subagents (${tasks.length}). The limit is ${MAX_PARALLEL_SUBAGENTS}; split the batch or use chain mode.`,
        );
      }
      const workers = tasks.map((task) => this.spawnOne(task));
      await Promise.all(workers.map((worker) => this.completions.get(worker.id)));
      results.push(...workers.map((worker) => this.resultOf(worker)));
    }

    const merged: SubagentMergeReport[] = [];
    if (options.merge) {
      for (const result of results) {
        const worker = this.workers.get(result.id);
        if (!worker?.worktreePath || result.state !== "completed") continue;
        try {
          const outcome = await this.worktrees.mergeAndCleanup(worker.id);
          merged.push({
            workerId: worker.id,
            merged: outcome.success,
            summary: outcome.success
              ? outcome.diffSummary
              : `conflicts: ${outcome.conflicts.join(", ")}`,
          });
        } catch (error) {
          merged.push({
            workerId: worker.id,
            merged: false,
            summary: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return { results, merged };
  }

  private resultOf(worker: SubagentWorkerState): SubagentResult {
    if (worker.result) return worker.result;
    return SubagentResultSchema.parse({
      id: worker.id,
      state: worker.status === "aborted" ? "aborted" : "failed",
      output: worker.transcript.slice(-10).join("\n"),
      error: worker.error ?? { code: "no_result", message: "worker finished without a result" },
    });
  }

  steer(workerId: string, instruction: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`unknown worker "${workerId}"`);
    if (worker.status !== "running" && worker.status !== "queued" && worker.status !== "preparing") {
      throw new Error(`worker "${workerId}" is ${worker.status} and cannot be steered`);
    }
    this.steerings.get(workerId)?.push(instruction);
  }

  kill(workerId: string): boolean {
    const worker = this.workers.get(workerId);
    const controller = this.controllers.get(workerId);
    if (!worker || !controller) return false;
    controller.abort();
    return true;
  }

  private async runWorker(
    worker: SubagentWorkerState,
    input: { task: string; mode?: AgentMode; outputJsonSchema?: JsonSchemaObject; writeIsolation?: boolean; onComplete?: (worker: SubagentWorkerState) => void },
    controller: AbortController,
  ): Promise<void> {    const startedAt = Date.now();
    const planWorker = (input.mode ?? "build") === "plan";
    const writeIsolation = planWorker ? false : input.writeIsolation ?? true;
    if (writeIsolation) {
      worker.status = "preparing";
      try {
        worker.worktreePath = await this.worktrees.createWorktree(worker.id);
      } catch (error) {
        worker.status = "failed";
        worker.error = { code: "worktree_failed", message: error instanceof Error ? error.message : String(error) };
        worker.updatedAt = Date.now();
        return;
      }
    }

    worker.status = "running";
    worker.updatedAt = Date.now();
    try {
      // The worker runs inside its own turn context so every tool resolves
      // paths and the shell against the worktree instead of the main checkout.
      const result = await runWithTurnContext(
        { mode: input.mode ?? "build", workspaceRoot: worker.worktreePath },
        () =>
          this.executor({
            workerId: worker.id,
            agent: worker.agent,
            task: buildTaskText(worker.task, input.outputJsonSchema),
            mode: input.mode,
            roleModel: worker.roleModel,
            provider: worker.provider,
            model: worker.model,
            outputJsonSchema: input.outputJsonSchema,
            writeIsolation,
            worktreePath: worker.worktreePath,
            signal: controller.signal,
            onTranscript: (line) => {
              worker.transcript.push(line);
              if (worker.transcript.length > TRANSCRIPT_LIMIT) worker.transcript.shift();
              worker.updatedAt = Date.now();
            },
            onUsage: (usage) => {
              const current = worker.usage ?? {
                prompt_tokens: 0,
                completion_tokens: 0,
                cost_usd: 0,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              };
              worker.usage = {
                prompt_tokens: current.prompt_tokens + usage.prompt_tokens,
                completion_tokens: current.completion_tokens + usage.completion_tokens,
                cost_usd: (current.cost_usd ?? 0) + (usage.cost_usd ?? 0),
                cache_read_input_tokens: current.cache_read_input_tokens + usage.cache_read_input_tokens,
                cache_creation_input_tokens: current.cache_creation_input_tokens + usage.cache_creation_input_tokens,
              };
            },
            drainSteerings: () => {
              const queued = this.steerings.get(worker.id) ?? [];
              this.steerings.set(worker.id, []);
              return queued;
            },
          }),
      );

      worker.status = "finalizing";
      if (input.outputJsonSchema) {
        try {
          worker.structuredOutput = JSON.parse(result.output) as unknown;
        } catch (error) {
          worker.status = "failed";
          worker.error = {
            code: "invalid_json_output",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (worker.status === "finalizing") worker.status = "completed";
      worker.result = SubagentResultSchema.parse({
        id: worker.id,
        state: worker.status === "completed" ? "completed" : "failed",
        output: result.output,
        usage: worker.usage ?? result.usage,
        diff: result.diff,
        files_changed: result.filesChanged ?? [],
        branch: result.branch,
        worktree_path: worker.worktreePath,
        error: worker.error,
        started_at: startedAt,
        finished_at: Date.now(),
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      worker.status = aborted ? "aborted" : "failed";
      worker.error = {
        code: aborted ? "aborted" : "executor_failed",
        message: error instanceof Error ? error.message : String(error),
      };
      worker.result = SubagentResultSchema.parse({
        id: worker.id,
        state: aborted ? "aborted" : "failed",
        output: worker.transcript.slice(-10).join("\n"),
        error: worker.error,
        started_at: startedAt,
        finished_at: Date.now(),
      });
    }
    worker.updatedAt = Date.now();
  }

  private spawnTool(): AgentTool {
    return {
      name: "spawn_subagents",
      description:
        [
          "Run tasks in isolated worker contexts.",
          'mode "parallel" (default) starts every task at once; mode "chain" runs them in order and replaces {previous} in each later task with the earlier worker output.',
          "Each task can set agent, a model role or provider/model route, a JSON output schema, and write isolation (a git worktree per worker).",
          "Chain steps share the working tree by default because a later step depends on the files the earlier one wrote; parallel workers are isolated by default.",
          "Set merge to merge each completed isolated worker back into the current branch afterwards.",
          "Each worker has its own context, so include every file path and decision it needs.",
        ].join(" "),
      parameters: z.object({
        tasks: z
          .array(
            z.object({
              id: z.string().min(1).optional(),
              agent: z.string().min(1).optional(),
              task: z.string().min(1),
              role_model: z.enum(["main", "fast", "advisor"]).optional(),
              provider: z.string().min(1).optional(),
              model: z.string().min(1).optional(),
              outputJsonSchema: z.record(z.string(), z.unknown()).optional(),
              writeIsolation: z.boolean().optional(),
            }),
          )
          .min(1),
        mode: z.enum(["parallel", "chain"]).default("parallel"),
        merge: z.boolean().default(false),
      }),
      readOnly: false,
      execute: async (args) => {
        const request = args as {
          tasks: Array<{
            id?: string;
            agent?: string;
            task: string;
            role_model?: "main" | "fast" | "advisor";
            provider?: string;
            model?: string;
            outputJsonSchema?: JsonSchemaObject;
            writeIsolation?: boolean;
          }>;
          mode: SubagentBatchMode;
          merge: boolean;
        };
        const batch = await this.spawnBatch(
          request.tasks.map((entry) => ({
            id: entry.id,
            agent: entry.agent,
            task: entry.task,
            roleModel: entry.role_model,
            provider: entry.provider,
            model: entry.model,
            outputJsonSchema: entry.outputJsonSchema,
            writeIsolation: entry.writeIsolation,
          })),
          { mode: request.mode, merge: request.merge },
        );

        const sections = batch.results.map((result) => {
          const lines = [`# subagent ${result.id} (${result.state})`];
          lines.push(result.error ? `${result.output}\nerror: ${result.error.message}` : result.output);
          if (result.files_changed.length > 0) {
            lines.push(`files: ${result.files_changed.join(", ")}`);
          }
          if (result.worktree_path) {
            lines.push(
              `worktree: ${result.worktree_path}${result.branch ? ` (branch ${result.branch})` : ""}`,
            );
          }
          if (result.diff) {
            lines.push(`diff:\n${result.diff.slice(0, 1500)}`);
          }
          return lines.join("\n");
        });
        const mergeReport =
          batch.merged.length > 0
            ? [
                "# merged",
                ...batch.merged.map(
                  (entry) =>
                    `- ${entry.workerId}: ${entry.merged ? "merged" : "not merged"}${
                      entry.summary ? ` (${entry.summary})` : ""
                    }`,
                ),
              ].join("\n")
            : "";
        return [...sections, mergeReport].filter(Boolean).join("\n\n");
      },
    };
  }
}

function buildTaskText(task: string, outputJsonSchema: JsonSchemaObject | undefined): string {
  if (!outputJsonSchema) return task;
  return `${task}\n\nRespond with a single JSON value that matches this JSON Schema:\n${JSON.stringify(outputJsonSchema)}`;
}
