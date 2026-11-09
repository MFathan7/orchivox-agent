import { z } from "zod";

import type { AgentTool } from "../tools/registry";
import type { JsonSchemaObject } from "../types/schema";
import { parseStructuredJson } from "./json-output";
import type { SpecialistAgentProfile, SpecialistAgentRegistry } from "./specialist-agents";
import { resolveSubagentSkillAccess } from "./skill-access";
import type { SkillRegistry } from "./skills";
import { normalizeSkillName } from "./skills";
import type { SubagentManager, SubagentSpawnTask } from "./subagent";
import type { TaskBoard, TaskItem } from "./task-board";

export const WorkPlanTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  task: z.string().min(1),
  agent: z.string().min(1).default("programmer"),
  skills: z.array(z.string().min(1)).default([]),
  depends_on: z.array(z.string().min(1)).default([]),
  write_isolation: z.boolean().default(true),
  mode: z.enum(["plan", "build", "ultrawork"]).optional(),
  acceptance: z.array(z.string().min(1)).default([]),
});
export type WorkPlanTask = z.infer<typeof WorkPlanTaskSchema>;

export const WorkPlanSchema = z.object({
  objective: z.string().min(1),
  constraints: z.array(z.string().min(1)).default([]),
  relevant_files: z.array(z.string().min(1)).default([]),
  tasks: z.array(WorkPlanTaskSchema).min(1),
  merge: z.boolean().default(false),
});
export type WorkPlan = z.infer<typeof WorkPlanSchema>;

const WORK_PLAN_JSON_SCHEMA = z.toJSONSchema(WorkPlanSchema, {
  target: "draft-7",
  io: "input",
}) as JsonSchemaObject;

export interface CoordinatorInput {
  goal: string;
  context?: string;
  constraints?: string[];
  files?: string[];
}

export interface CoordinatorResult {
  plan: WorkPlan;
  tasks: TaskItem[];
  warnings: string[];
  started: number;
}

export interface CoordinatorOptions {
  checkTask?: (task: SubagentSpawnTask) => Promise<void>;
  subagents: SubagentManager;
  tasks: TaskBoard;
  agents: SpecialistAgentRegistry;
  skills: SkillRegistry;
  coordinatorAgent?: string;
  maxTasks?: number;
}

const WORKER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

export class Coordinator {
  private readonly subagents: SubagentManager;
  private readonly tasks: TaskBoard;
  private readonly agents: SpecialistAgentRegistry;
  private readonly skills: SkillRegistry;
  private readonly coordinatorAgent: string;
  private readonly maxTasks: number;
  private readonly checkTask?: CoordinatorOptions["checkTask"];

  constructor(options: CoordinatorOptions) {
    this.subagents = options.subagents;
    this.tasks = options.tasks;
    this.agents = options.agents;
    this.skills = options.skills;
    this.coordinatorAgent = options.coordinatorAgent ?? "polaris";
    this.maxTasks = Math.max(1, options.maxTasks ?? 10);
    this.checkTask = options.checkTask;
  }

  async coordinate(input: CoordinatorInput, signal?: AbortSignal): Promise<CoordinatorResult> {
    const profiles = await this.agents.listAgents();
    const profileByName = new Map(
      profiles.map((profile) => [profile.name.toLowerCase(), profile]),
    );
    if (!profileByName.has(this.coordinatorAgent.toLowerCase())) {
      throw new Error(`coordinator agent "${this.coordinatorAgent}" is not registered`);
    }
    await this.checkTask?.({ agent: this.coordinatorAgent, task: input.goal, mode: "plan" });

    const plan = await this.requestPlan(input, profiles, profileByName, signal);
    for (const task of plan.tasks) {
      signal?.throwIfAborted();
      await this.checkTask?.({ agent: task.agent, task: task.task, mode: task.mode ?? "build" });
    }

    const installedSkills = new Map(
      this.skills.listDocuments().map((document) => [
        normalizeSkillName(document.name),
        document.name,
      ]),
    );
    const warnings: string[] = [];
    const inputs = plan.tasks.map((task) => {
      const profile = profileByName.get(task.agent.toLowerCase());
      if (!profile) {
        throw new Error(`Polaris assigned an unknown agent "${task.agent}"`);
      }

      const requested = [...new Set(task.skills.map((name) => name.trim()).filter(Boolean))];
      const installed: string[] = [];
      for (const name of requested) {
        const resolved = installedSkills.get(normalizeSkillName(name));
        if (resolved) installed.push(resolved);
        else warnings.push(`task ${task.id}: skill "${name}" is not installed`);
      }

      const access = resolveSubagentSkillAccess(profile, installed);
      for (const dropped of access.dropped) {
        if (
          !installed.some(
            (name) => normalizeSkillName(name) === normalizeSkillName(dropped),
          )
        ) {
          continue;
        }
        warnings.push(`task ${task.id}: skill "${dropped}" is not allowed for ${profile.name}`);
      }

      const mode = profile.readOnly ? "plan" : task.mode ?? "build";
      const writeIsolation = mode === "plan" ? false : task.write_isolation;
      const effectiveSkills = access.policy === "all" ? installed : access.allowed;

      return {
        id: task.id,
        title: task.title,
        task: renderTaskText(plan, task),
        agent: task.agent,
        mode,
        dependsOn: task.depends_on,
        writeIsolation,
        skills: effectiveSkills,
      };
    });

    const existingIds = new Set(this.tasks.list().map((task) => task.id));
    const needsNamespace = inputs.some((task) => existingIds.has(task.id));
    const prefix = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}-`;
    const idMap = new Map(
      inputs.map((task) => [task.id, needsNamespace ? `${prefix}${task.id}` : task.id]),
    );
    const namespaced = inputs.map((task) => ({
      ...task,
      id: idMap.get(task.id) ?? task.id,
      dependsOn: task.dependsOn.map((dependency) => idMap.get(dependency) ?? dependency),
    }));
    const created = this.tasks.add(namespaced, signal);
    const started = this.tasks.dispatch();
    return { plan, tasks: created, warnings, started };
  }

  private async requestPlan(
    input: CoordinatorInput,
    profiles: SpecialistAgentProfile[],
    profileByName: Map<string, SpecialistAgentProfile>,
    signal?: AbortSignal,
  ): Promise<WorkPlan> {
    let lastError: PlanValidationError | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal?.aborted) throw new Error("coordinator cancelled");
      const taskText = buildCoordinatorTask(input, profiles, attempt > 0 ? lastError : undefined);
      try {
        const plan = await this.runPlanner(taskText, signal);
        this.validatePlan(plan, profileByName);
        return plan;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!(error instanceof PlanValidationError)) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new PlanValidationError("Polaris returned an invalid WorkPlan");
  }

  private async runPlanner(taskText: string, signal?: AbortSignal): Promise<WorkPlan> {
    const batch = await this.subagents.spawnBatch(
      [
        {
          agent: this.coordinatorAgent,
          task: taskText,
          mode: "plan",
          writeIsolation: false,
          outputJsonSchema: WORK_PLAN_JSON_SCHEMA,
        },
      ],
      { mode: "chain", signal },
    );
    const result = batch.results[0];

    if (!result) throw new PlanValidationError("Polaris did not return a plan");
    if (result.state !== "completed") {
      if (result.error?.code === "invalid_json_output") {
        throw new PlanValidationError(
          `Polaris returned invalid JSON: ${result.error.message}`,
        );
      }
      throw new Error(
        result.error?.message
          ? `Polaris failed: ${result.error.message}`
          : `Polaris stopped without a plan (${result.state})`,
      );
    }

    const worker = this.subagents.getWorker(result.id);
    let structured = worker?.structuredOutput;
    if (structured === undefined) {
      try {
        structured = parseStructuredJson(result.output);
      } catch (error) {
        throw new PlanValidationError(
          `Polaris returned text that is not a WorkPlan JSON object: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const parsed = WorkPlanSchema.safeParse(structured);
    if (!parsed.success) {
      throw new PlanValidationError(
        `Polaris returned an invalid WorkPlan: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data;
  }

  private validatePlan(
    plan: WorkPlan,
    profileByName: Map<string, SpecialistAgentProfile>,
  ): void {
    if (plan.tasks.length > this.maxTasks) {
      throw new PlanValidationError(
        `Polaris planned ${plan.tasks.length} tasks; the limit is ${this.maxTasks}`,
      );
    }

    const ids = new Set<string>();
    for (const task of plan.tasks) {
      if (!WORKER_ID_PATTERN.test(task.id)) {
        throw new PlanValidationError(
          `Polaris used an invalid task id "${task.id}": use letters, digits, dots, underscores, or dashes`,
        );
      }
      if (ids.has(task.id)) {
        throw new PlanValidationError(`Polaris used the duplicate task id "${task.id}"`);
      }
      ids.add(task.id);
      if (!profileByName.has(task.agent.toLowerCase())) {
        throw new PlanValidationError(`Polaris assigned an unknown agent "${task.agent}"`);
      }
    }

    for (const task of plan.tasks) {
      for (const dependency of task.depends_on) {
        if (!ids.has(dependency)) {
          throw new PlanValidationError(
            `task "${task.id}" depends on unknown task "${dependency}"`,
          );
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(plan.tasks.map((task) => [task.id, task]));
    const visit = (id: string): void => {
      if (visiting.has(id)) {
        throw new PlanValidationError(`Polaris planned a dependency cycle at "${id}"`);
      }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of byId.get(id)?.depends_on ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const task of plan.tasks) visit(task.id);
  }
}

function buildCoordinatorTask(
  input: CoordinatorInput,
  profiles: SpecialistAgentProfile[],
  correction?: PlanValidationError,
): string {
  return [
    "Plan the following request for a team of workers.",
    `Goal:\n${input.goal}`,
    input.context ? `Context:\n${input.context}` : "",
    input.constraints && input.constraints.length > 0
      ? `Constraints:\n${input.constraints.map((entry) => `- ${entry}`).join("\n")}`
      : "",
    input.files && input.files.length > 0
      ? `Relevant files:\n${input.files.map((entry) => `- ${entry}`).join("\n")}`
      : "",
    `Available agents:\n${profiles
      .map(
        (profile) =>
          `- ${profile.name}: ${profile.description}${profile.readOnly ? " (read-only)" : ""}`,
      )
      .join("\n")}`,
    "Return only the WorkPlan JSON, with no prose around it.",
    "Return exactly one complete JSON object. Do not use trailing commas. Do not close the tasks array before every task object is inside it. Do not wrap the JSON in Markdown code fences.",
    correction
      ? [
          `Your previous response was rejected: ${correction.message}`,
          "Return one complete JSON object that matches the schema. Do not use trailing commas. Do not close the tasks array before all tasks. Do not use Markdown fences or prose.",
        ].join(" ")
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderTaskText(plan: WorkPlan, task: WorkPlanTask): string {
  return [
    task.task,
    plan.constraints.length > 0
      ? `Constraints:\n${plan.constraints.map((entry) => `- ${entry}`).join("\n")}`
      : "",
    plan.relevant_files.length > 0
      ? `Relevant files:\n${plan.relevant_files.map((entry) => `- ${entry}`).join("\n")}`
      : "",
    task.acceptance.length > 0
      ? `Acceptance criteria:\n${task.acceptance.map((entry) => `- ${entry}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function formatCoordinatorPlan(result: CoordinatorResult): string {
  return [
    "# Coordinator plan",
    `Objective: ${result.plan.objective}`,
    result.plan.constraints.length > 0
      ? `Constraints:\n${result.plan.constraints.map((entry) => `- ${entry}`).join("\n")}`
      : "",
    "Tasks:",
    ...result.tasks.map(
      (task) =>
        `- ${task.id} [${task.state}] ${task.title} (agent=${task.agent ?? "programmer"}${
          task.skills && task.skills.length > 0 ? `, skills=${task.skills.join(",")}` : ""
        })`,
    ),
    result.warnings.length > 0
      ? `Warnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}`
      : "",
    "Use task_wait to collect the results. Review them and merge only what passes.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function createCoordinateTool(options: {
  coordinator: Coordinator;
  enabled: () => boolean;
}): AgentTool {
  return {
    name: "coordinate",
    description:
      "Plan multi-step work with the read-only Polaris coordinator and create worker tasks. Use this when a goal needs more than one independent step or a specialist. Polaris cannot edit files. Returns the plan and task ids; call task_wait to collect results.",
    parameters: z.object({
      goal: z.string().min(1).describe("The outcome the user wants."),
      context: z
        .string()
        .optional()
        .describe("Relevant context that workers cannot recover from the repository."),
      constraints: z
        .array(z.string().min(1))
        .optional()
        .describe("Hard constraints the plan and workers must respect."),
      files: z
        .array(z.string().min(1))
        .optional()
        .describe("Files that are known to be relevant."),
    }),
    readOnly: false,
    execute: async (args, context) => {
      if (!options.enabled()) {
        throw new Error("Auto coordinator is off. Enable it in /settings first.");
      }
      const input = args as CoordinatorInput;
      const result = await options.coordinator.coordinate(input, context?.signal);
      const lines = [
        `Polaris plan: ${result.plan.objective}`,
        `Created ${result.tasks.length} task(s), started ${result.started}.`,
        ...result.tasks.map(
          (task) =>
            `- ${task.id} [${task.state}] ${task.title} (agent=${task.agent ?? "programmer"}${
              task.skills && task.skills.length > 0 ? `, skills=${task.skills.join(",")}` : ""
            })`,
        ),
        result.warnings.length > 0
          ? `Warnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}`
          : "",
        result.plan.merge ? "Merge requested after the tasks complete." : "",
        "Call task_wait to collect the results.",
      ].filter(Boolean);
      return lines.join("\n");
    },
  };
}
