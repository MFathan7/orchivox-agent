import { z } from "zod";

import type { AgentMode } from "../types/schema";
import type { AgentTool, ToolRegistry } from "../tools/registry";
import { currentTurnContext } from "./turn-context";

export const TaskStateSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskRoleSchema = z.enum(["main", "fast", "advisor"]);
export type TaskRole = z.infer<typeof TaskRoleSchema>;

export interface TaskItem {
  id: string;
  title: string;
  task: string;
  agent?: string;
  mode?: AgentMode;
  roleModel?: TaskRole;
  provider?: string;
  model?: string;
  dependsOn: string[];
  writeIsolation: boolean;
  state: TaskState;
  workerId?: string;
  result?: string;
  error?: string;
  diff?: string;
  filesChanged: string[];
  merged?: boolean;
  mergeSummary?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskCreateInput {
  id?: string;
  title: string;
  task: string;
  agent?: string;
  mode?: AgentMode;
  roleModel?: TaskRole;
  provider?: string;
  model?: string;
  dependsOn?: string[];
  writeIsolation?: boolean;
}

export interface TaskSpawnInput {
  id: string;
  task: string;
  agent?: string;
  mode?: AgentMode;
  roleModel?: TaskRole;
  provider?: string;
  model?: string;
  writeIsolation: boolean;
}

export interface TaskWorkerOutcome {
  output?: string;
  error?: string;
  diff?: string;
  filesChanged?: string[];
}

export interface TaskSpawnHandle {
  workerId: string;
  done: Promise<TaskWorkerOutcome>;
}

export type TaskSpawner = (input: TaskSpawnInput) => TaskSpawnHandle;
export type TaskCanceller = (workerId: string) => boolean;
export type TaskMerger = (workerId: string) => Promise<{
  success: boolean;
  diffSummary: string;
  conflicts: string[];
}>;

export interface TaskStore {
  loadTasks(): TaskItem[];
  saveTask(task: TaskItem): void;
  deleteTask(id: string): void;
}

export interface TaskBoardOptions {
  spawner: TaskSpawner;
  canceller?: TaskCanceller;
  merger?: TaskMerger;
  maxConcurrent?: number;
  onUpdate?: (task: TaskItem) => void;
  store?: TaskStore;
}

const RESULT_EXCERPT = 400;
const CHAIN_RESULT_LIMIT = 12_000;

export class TaskBoard {
  private readonly tasks = new Map<string, TaskItem>();
  private readonly spawner: TaskSpawner;
  private readonly canceller: TaskCanceller | undefined;
  private readonly merger: TaskMerger | undefined;
  private readonly maxConcurrent: number;
  private readonly onUpdate: ((task: TaskItem) => void) | undefined;
  private readonly store: TaskStore | undefined;
  private active = 0;
  private counter = 0;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(options: TaskBoardOptions) {
    this.spawner = options.spawner;
    this.canceller = options.canceller;
    this.merger = options.merger;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 3);
    this.onUpdate = options.onUpdate;
    this.store = options.store;
    if (this.store) this.hydrate(this.store.loadTasks());
  }

  private hydrate(tasks: TaskItem[]): void {
    for (const task of tasks) {
      const restored: TaskItem = {
        ...task,
        dependsOn: [...task.dependsOn],
        filesChanged: [...task.filesChanged],
      };
      if (restored.state === "running") {
        restored.state = "pending";
        restored.workerId = undefined;
        restored.error = "worker was interrupted by a restart; queued for dispatch";
        restored.updatedAt = Date.now();
        this.store?.saveTask(restored);
      }
      this.tasks.set(restored.id, restored);
    }
    this.counter = Math.max(this.counter, this.tasks.size);
    this.refreshBlocked();
  }

  private persist(task: TaskItem): void {
    if (!this.tasks.has(task.id)) return;
    this.store?.saveTask(task);
  }

  remove(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.state === "running" && task.workerId) this.canceller?.(task.workerId);
    this.tasks.delete(id);
    this.store?.deleteTask(id);
    this.refreshBlocked();
    return true;
  }

  add(input: TaskCreateInput | TaskCreateInput[]): TaskItem[] {
    const requests = Array.isArray(input) ? input : [input];
    const created: TaskItem[] = [];

    for (const request of requests) {
      const id = request.id ?? `task-${Date.now().toString(36)}-${++this.counter}`;
      if (!/^[A-Za-z0-9._-]+$/.test(id)) {
        throw new Error(`invalid task id "${id}": use letters, digits, dots, underscores, or dashes`);
      }
      if (this.tasks.has(id)) throw new Error(`task "${id}" already exists`);

      const now = Date.now();
      const item: TaskItem = {
        id,
        title: request.title,
        task: request.task,
        agent: request.agent,
        mode: request.mode ?? currentTurnContext()?.mode ?? "build",
        roleModel: request.roleModel,
        provider: request.provider,
        model: request.model,
        dependsOn: request.dependsOn ?? [],
        writeIsolation: request.writeIsolation ?? true,
        state: "pending",
        filesChanged: [],
        createdAt: now,
        updatedAt: now,
      };
      this.tasks.set(id, item);
      created.push(item);
    }

    for (const item of created) {
      for (const dependency of item.dependsOn) {
        if (dependency === item.id) {
          item.state = "blocked";
          item.error = "a task cannot depend on itself";
        } else if (!this.tasks.has(dependency)) {
          item.state = "blocked";
          item.error = `unknown dependency "${dependency}"`;
        }
      }
    }

    this.blockCycles(created);

    for (const item of created) this.persist(item);
    return created;
  }

  /** Blocks tasks that depend on each other in a loop, which would never start. */
  private blockCycles(created: TaskItem[]): void {
    const visit = (
      id: string,
      path: string[],
      done: Set<string>,
      stack: Set<string>,
    ): string[] | undefined => {
      if (stack.has(id)) {
        const start = path.indexOf(id);
        return [...path.slice(start), id];
      }
      if (done.has(id)) return undefined;
      const task = this.tasks.get(id);
      if (!task) return undefined;
      done.add(id);
      stack.add(id);
      path.push(id);
      for (const dependency of task.dependsOn) {
        const cycle = visit(dependency, path, done, stack);
        if (cycle) return cycle;
      }
      path.pop();
      stack.delete(id);
      return undefined;
    };

    for (const item of created) {
      const cycle = visit(item.id, [], new Set(), new Set());
      if (!cycle) continue;
      for (const id of cycle) {
        const task = this.tasks.get(id);
        if (!task || task.state !== "pending") continue;
        task.state = "blocked";
        task.error = `dependency cycle: ${cycle.join(" -> ")}`;
        task.updatedAt = Date.now();
      }
    }
  }

  list(): TaskItem[] {
    return [...this.tasks.values()].sort((left, right) => left.createdAt - right.createdAt);
  }

  get(id: string): TaskItem | undefined {
    return this.tasks.get(id);
  }

  summary(): { total: number; completed: number; running: number; blocked: number; failed: number } {
    const items = this.list();
    return {
      total: items.length,
      completed: items.filter((item) => item.state === "completed").length,
      running: items.filter((item) => item.state === "running").length,
      blocked: items.filter((item) => item.state === "blocked").length,
      failed: items.filter((item) => item.state === "failed").length,
    };
  }

  dispatch(): number {
    this.refreshBlocked();
    let started = 0;

    while (this.active < this.maxConcurrent) {
      const next = this.list().find((task) => task.state === "pending" && this.dependenciesComplete(task));
      if (!next) break;
      this.startTask(next);
      started += 1;
    }

    this.refreshBlocked();
    return started;
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.state === "completed" || task.state === "cancelled") return false;

    if (task.state === "running" && task.workerId) {
      this.canceller?.(task.workerId);
    }

    task.state = "cancelled";
    task.updatedAt = Date.now();
    this.onUpdate?.(task);
    this.persist(task);
    this.refreshBlocked();
    this.dispatch();
    return true;
  }

  registerTools(registry: ToolRegistry): void {
    registry.register(this.createTool());
    registry.register(this.listTool());
    registry.register(this.dispatchTool());
    registry.register(this.cancelTool());
    registry.register(this.mergeTool());
    registry.register(this.waitTool());
  }

  async waitForIdle(): Promise<void> {
    this.dispatch();
    if (this.active === 0) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  async merge(id: string): Promise<string> {
    const task = this.tasks.get(id);
    if (!task) return `unknown task "${id}"`;
    if (!task.workerId) return `task "${id}" has no worker to merge`;
    if (task.state !== "completed") return `task "${id}" is ${task.state}; only completed tasks can be merged`;
    if (!this.merger) return "merging is not configured";

    try {
      const result = await this.merger(task.workerId);
      task.merged = result.success;
      task.mergeSummary = result.success ? result.diffSummary : `conflicts: ${result.conflicts.join(", ")}`;
      task.updatedAt = Date.now();
      this.onUpdate?.(task);
      this.persist(task);
      return result.success
        ? `merged ${id}: ${result.diffSummary.length > 0 ? result.diffSummary : "no changes"}`
        : `merge failed for ${id}: ${result.conflicts.length > 0 ? result.conflicts.join(", ") : "unknown conflict"}`;
    } catch (error) {
      return `merge failed for ${id}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private dependenciesComplete(task: TaskItem): boolean {
    return task.dependsOn.every((dependency) => this.tasks.get(dependency)?.state === "completed");
  }

  private refreshBlocked(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of this.tasks.values()) {
        if (task.state !== "pending") continue;
        const broken = task.dependsOn.find((dependency) => {
          const dependencyTask = this.tasks.get(dependency);
          if (!dependencyTask) return true;
          return (
            dependencyTask.state === "failed" ||
            dependencyTask.state === "blocked" ||
            dependencyTask.state === "cancelled"
          );
        });
        if (broken) {
          task.state = "blocked";
          task.error = `dependency "${broken}" did not complete`;
          task.updatedAt = Date.now();
          this.onUpdate?.(task);
          this.persist(task);
          changed = true;
        }
      }
    }
  }

  /**
   * Replaces {previous} with the last dependency result and {result:<id>} with a
   * named dependency result, so a chain of tasks can pass work forward.
   */
  private renderTaskText(task: TaskItem): string {
    let text = task.task;
    const previousId = task.dependsOn[task.dependsOn.length - 1];
    if (previousId && text.includes("{previous}")) {
      text = text.split("{previous}").join(this.dependencyResult(previousId));
    }
    for (const dependencyId of task.dependsOn) {
      const token = `{result:${dependencyId}}`;
      if (text.includes(token)) {
        text = text.split(token).join(this.dependencyResult(dependencyId));
      }
    }
    return text;
  }

  private dependencyResult(taskId: string): string {
    const dependency = this.tasks.get(taskId);
    const value = dependency?.result ?? "";
    if (value.length === 0) return "(no result from " + taskId + ")";
    return value.length > CHAIN_RESULT_LIMIT
      ? `${value.slice(0, CHAIN_RESULT_LIMIT)}\n\n[... result truncated to fit the next task]`
      : value;
  }

  private startTask(task: TaskItem): void {
    task.state = "running";
    task.updatedAt = Date.now();
    this.active += 1;
    this.persist(task);

    let handle: TaskSpawnHandle;
    try {
      handle = this.spawner({
        id: task.id,
        task: this.renderTaskText(task),
        agent: task.agent,
        mode: task.mode,
        roleModel: task.roleModel,
        provider: task.provider,
        model: task.model,
        writeIsolation: task.writeIsolation,
      });
    } catch (error) {
      this.active = Math.max(0, this.active - 1);
      task.state = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.updatedAt = Date.now();
      this.onUpdate?.(task);
      this.persist(task);
      return;
    }

    task.workerId = handle.workerId;
    this.onUpdate?.(task);
    this.persist(task);

    void handle.done
      .then((outcome) => {
        if (task.state !== "cancelled") {
          task.state = outcome.error ? "failed" : "completed";
          task.result = outcome.output;
          task.error = outcome.error;
          task.diff = outcome.diff;
          task.filesChanged = outcome.filesChanged ?? [];
        }
        task.updatedAt = Date.now();
        this.onUpdate?.(task);
        this.persist(task);
      })
      .catch((error: unknown) => {
        if (task.state !== "cancelled") {
          task.state = "failed";
          task.error = error instanceof Error ? error.message : String(error);
        }
        task.updatedAt = Date.now();
        this.onUpdate?.(task);
        this.persist(task);
      })
      .finally(() => {
        this.active = Math.max(0, this.active - 1);
        this.dispatch();
        if (this.active === 0) {
          for (const resolve of this.idleWaiters.splice(0)) resolve();
        }
      });
  }

  private createTool(): AgentTool {
    return {
      name: "task_create",
      description:
        [
          "Create tasks on the multi-agent board. Each task becomes a subagent worker with its own context, optionally isolated in a git worktree and routed to a model role or provider/model.",
          "Use depends_on to build a DAG, and write {previous} or {result:<task-id>} inside a task to hand a dependency result to it, which turns a chain of tasks into a pipeline.",
          "Chain steps see each other's files only when write_isolation is false, which is the right choice for a pipeline that edits the same files.",
          "Include every file path and decision the worker needs. Tasks start automatically unless auto_start is false.",
        ].join(" "),
      parameters: z.object({
        tasks: z
          .array(
            z.object({
              id: z.string().min(1).optional(),
              title: z.string().min(1),
              task: z.string().min(1),
              agent: z.string().min(1).optional(),
              depends_on: z.array(z.string().min(1)).default([]),
              role_model: TaskRoleSchema.optional(),
              provider: z.string().min(1).optional(),
              model: z.string().min(1).optional(),
              write_isolation: z.boolean().default(true),
            }),
          )
          .min(1),
        auto_start: z.boolean().default(true),
      }),
      readOnly: false,
      execute: (args) => {
        const request = args as {
          tasks: Array<{
            id?: string;
            title: string;
            task: string;
            agent?: string;
            depends_on: string[];
            role_model?: TaskRole;
            provider?: string;
            model?: string;
            write_isolation: boolean;
          }>;
          auto_start: boolean;
        };

        const created = this.add(
          request.tasks.map((entry) => ({
            id: entry.id,
            title: entry.title,
            task: entry.task,
            agent: entry.agent,
            roleModel: entry.role_model,
            provider: entry.provider,
            model: entry.model,
            dependsOn: entry.depends_on,
            writeIsolation: entry.write_isolation,
          })),
        );

        const started = request.auto_start ? this.dispatch() : 0;
        const lines = created.map(
          (task) => `- ${task.id} [${task.state}] ${task.title}${task.dependsOn.length > 0 ? ` after ${task.dependsOn.join(", ")}` : ""}`,
        );
        return [`created ${created.length} task(s), started ${started}`, ...lines].join("\n");
      },
    };
  }

  private listTool(): AgentTool {
    return {
      name: "task_list",
      description: "List the multi-agent task board with state, dependencies, worker ids, and short results.",
      parameters: z.object({}),
      readOnly: true,
      execute: () => this.formatList(),
    };
  }

  private formatList(): string {
    const items = this.list();
    if (items.length === 0) return "task board is empty";
    return items
      .map((task) => {
        const deps = task.dependsOn.length > 0 ? ` after ${task.dependsOn.join(", ")}` : "";
        const mode = task.mode ? ` mode=${task.mode}` : "";
        const worker = task.workerId ? ` worker=${task.workerId}` : "";
        const files = task.filesChanged.length > 0 ? ` files=${task.filesChanged.join(",")}` : "";
        const result = task.result
          ? `\n  result: ${task.result.slice(0, RESULT_EXCERPT).replace(/\n/g, " ")}`
          : task.error
            ? `\n  error: ${task.error}`
            : "";
        const merged = task.merged === undefined ? "" : task.merged ? " merged" : " merge-failed";
        return `- ${task.id} [${task.state}] ${task.title}${deps}${mode}${worker}${files}${merged}${result}`;
      })
      .join("\n");
  }

  private waitTool(): AgentTool {
    return {
      name: "task_wait",
      description:
        "Wait until no task is running, starting ready tasks as dependencies complete. Returns the final board with results.",
      parameters: z.object({}),
      readOnly: false,
      execute: async () => {
        await this.waitForIdle();
        return this.formatList();
      },
    };
  }

  private dispatchTool(): AgentTool {
    return {
      name: "task_dispatch",
      description:
        "Start every pending task whose dependencies are complete, up to the concurrency limit. Call again after finishing partial work.",
      parameters: z.object({}),
      readOnly: false,
      execute: () => {
        const started = this.dispatch();
        const summary = this.summary();
        return `started ${started} task(s). ${summary.running} running, ${summary.completed}/${summary.total} completed, ${summary.blocked} blocked.`;
      },
    };
  }

  private cancelTool(): AgentTool {
    return {
      name: "task_cancel",
      description: "Cancel a pending or running task. Dependents become blocked.",
      parameters: z.object({
        id: z.string().min(1),
      }),
      readOnly: false,
      execute: (args) => {
        const { id } = args as { id: string };
        const cancelled = this.cancel(id);
        return cancelled ? `cancelled task ${id}` : `task ${id} was not running or does not exist`;
      },
    };
  }

  private mergeTool(): AgentTool {
    return {
      name: "task_merge",
      description:
        "Merge a completed task's worker branch into the current branch, then remove its worktree. Returns the diff summary or the conflicting files.",
      parameters: z.object({
        id: z.string().min(1),
      }),
      readOnly: false,
      execute: (args) => this.merge((args as { id: string }).id),
    };
  }
}
