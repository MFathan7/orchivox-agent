import { z } from "zod";

import type { AgentTool, ToolRegistry } from "../tools/registry";
import type { JsonSchemaObject, SubagentResult, SubagentState, Usage } from "../types/schema";
import { SubagentResultSchema } from "../types/schema";
import type { AgentMode } from "../types/schema";
import type { WorktreeManager } from "../vcs/worktree";
import { currentTurnContext } from "./turn-context";

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

const WORKER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
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

  async spawn(
    tasks: Array<{ id?: string; agent?: string; task: string; mode?: AgentMode; roleModel?: "main" | "fast" | "advisor"; provider?: string; model?: string; outputJsonSchema?: JsonSchemaObject; writeIsolation?: boolean }>,
  ): Promise<SubagentResult[]> {
    const workers = tasks.map((task) => this.spawnOne(task));
    await Promise.all(tasks.map((_, index) => this.completions.get(workers[index].id)));
    return workers.map((worker) => {
      if (worker.result) return worker.result;
      return SubagentResultSchema.parse({
        id: worker.id,
        state: worker.status === "aborted" ? "aborted" : "failed",
        output: worker.transcript.slice(-10).join("\n"),
        error: worker.error ?? { code: "no_result", message: "worker finished without a result" },
      });
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
    const writeIsolation = input.writeIsolation ?? true;
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
      const result = await this.executor({
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
      });

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
        "Run independent tasks in parallel, optionally with file-write isolation (a git worktree per worker), a model role or provider/model route, and a JSON output schema. Each worker has its own context, so include every file path and decision it needs. Returns each worker result when all finish.",
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
              writeIsolation: z.boolean().default(true),
            }),
          )
          .min(1),
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
        };
        const results = await this.spawn(
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
        );
        return results
          .map((result) => {
            const header = `# subagent ${result.id} (${result.state})`;
            const body = result.error ? `${result.output}\nerror: ${result.error.message}` : result.output;
            return `${header}\n${body}`;
          })
          .join("\n\n");
      },
    };
  }
}

function buildTaskText(task: string, outputJsonSchema: JsonSchemaObject | undefined): string {
  if (!outputJsonSchema) return task;
  return `${task}\n\nRespond with a single JSON value that matches this JSON Schema:\n${JSON.stringify(outputJsonSchema)}`;
}
