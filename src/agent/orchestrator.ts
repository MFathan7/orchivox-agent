import type {
  AgentRunRequest,
  AgentRunResult,
  AgentTask,
  AgentTaskRequest,
  AgentProfile,
  IAgentRunner,
} from "../api/server";
import type { AppConfig, CompactionConfig, WebFetchConfig, WebSearchConfig } from "../config/loader";
import { join } from "node:path";
import { structuredPatch } from "diff";
import { registerAstTools } from "../ide/ast-compress";
import { registerCodeIntelTools } from "../ide/code-intel";
import type { LSPClient } from "../ide/lsp-client";
import { HindsightMemory, estimateMessageTokens } from "../memory/hindsight";
import type { MemoryDatabase } from "../memory/sqlite";
import type { RulesLoader } from "../memory/rules-loader";
import type { ProviderRouter } from "../provider/router";
import {
  createDiffViewTool,
  createGlobFilesTool,
  createGrepSearchTool,
  createJsonQueryTool,
} from "../tools/builtins";
import {
  createApplyUnifiedPatchTool,
  createCreateFileTool,
  createDeleteFileTool,
  createHashEditTool,
  createMoveFileTool,
  createReadFileTool,
  createReplaceTextTool,
  type HashlineLifecycle,
} from "../tools/hashline-edit";
import {
  buildSelfHealingPrompt,
  createDiagnosticsCheckTool,
  runTscDiagnostics,
  type LSPDiagnostic,
} from "../ide/lsp-fixer";
import { createSandboxScriptTool } from "../tools/sandbox-bridge";
import { ToolRegistry } from "../tools/registry";
import { PersistentShellTool } from "../tools/shell";
import { BackgroundProcessManager } from "../tools/bg-process";
import { createInspectImageTool } from "../tools/vision";
import { createReadDocumentTool } from "../tools/read-document";
import { createWritePlanTool } from "../tools/plan-file";
import { registerWebTools, type WebSearchSession } from "../tools/web-reader";
import {
  ChatRequestSchema,
  type AgentMode,
  type FinishReason,
  type Message,
  type StreamEvent,
  type ToolCall,
  type ToolCallDeltaEvent,
  type ToolCallReadyEvent,
  type ToolUseBlock,
  type TurnMetrics,
  type Usage,
  type UsageEvent,
} from "../types/schema";
import type { SnapshotManager } from "../vcs/snapshot";
import type { WorktreeManager } from "../vcs/worktree";
import { AdvisorReviewer } from "./advisor";
import {
  compactMessages,
  computeInputBudget,
  estimateTextTokens,
  estimateToolsTokens,
  estimateRequestBytes,
  extractSummary,
  isSyntheticMessage,
  precomputeCompaction,
  pruneToolOutput,
  reduceTranscriptForOverflow,
  resolveCompactionBuffer,
  OVERFLOW_SHRINK_STEPS,
  type PrecomputedCompaction,
} from "./compaction";
import { appendUsageLog, usageLogEnabled } from "./usage-log";
import { TurnMetricsTracker, timeBudgetReached, turnBudgetWarning } from "./turn-metrics";
import { ReadFileCache, ToolCallTracker, toolCallSignature } from "./tool-call-tracker";
import { filterToolsForMode, isConcurrentSafeTool } from "./tool-set";
import { CustomCommandEngine } from "./custom-commands";
import { HookRunner, type PluginLoadReport } from "./hooks";
import { GranularPermissionEngine, permissionRulesFromConfig } from "./permissions";
import { SpecialistAgentRegistry, type SpecialistAgentProfile } from "./specialist-agents";
import {
  loadProjectContext,
  type ProjectContext,
} from "./project-context";
import { createQuestionTool, type QuestionHandler } from "../tools/question";
import { parseTextToolCall } from "./text-tool-call";
import {
  looksLikeInternalDump,
  sanitizeAssistantText,
} from "./output-sanitizer";
import { toolDisplay } from "./tool-display";
import {
  buildSkillHint,
  formatSkillReload,
  loadedSkillIds,
  matchSkillNames,
  parseSkillMentions,
  SkillRegistry,
  type SkillDocument,
} from "./skills";
import { SubagentManager, type SubagentTaskInput, type SubagentTaskResult, type SubagentWorkerState } from "./subagent";
import { closingReminder } from "./prompt/base";
import { instructionBlocks } from "./prompt/instructions";
import { planEnterReminder, planLeaveReminder } from "./prompt/plan-mode";
import {
  instructionMessage,
  mergeInstructionMessages,
  planInstructionUpdates,
  type InstructionState,
} from "./prompt/instruction-state";
import { buildSystemParts } from "./prompt";
import { TaskBoard, type TaskSpawnInput, type TaskWorkerOutcome } from "./task-board";
import { currentTurnContext, runWithTurnContext } from "./turn-context";
import { sleepAbortable } from "../provider/retry";
import {
  isContextOverflowError,
  isOutputBudgetError,
  isUnsupportedParamsError,
} from "../provider/errors";
import { modeContract, modeStepLimit, modeTransitionReminder } from "./modes";
import { SKILL_ALWAYS_ALLOWED_TOOLS, SkillToolPolicy } from "./skill-policy";
import { TodoEngine } from "./todo";
import { runGit } from "../vcs/git";

export interface ReloadReport {
  skills: number;
  commands: number;
  agents: number;
  /** Whether project rules (AGENTS.md) were found. */
  rules: boolean;
  /** Whether the project summary could be rebuilt. */
  projectContext: boolean;
}

export interface AgentOrchestratorOptions {
  router: ProviderRouter;
  worktrees: WorktreeManager;
  snapshots: SnapshotManager;
  rules: RulesLoader;
  database: MemoryDatabase;
  config?: AppConfig;
  lsp?: LSPClient;
  hashEditLifecycle?: HashlineLifecycle;
  repoRoot?: string;
  /** Main-agent step cap. Omitted or 0 means run until the model stops. */
  maxTurns?: number;
  contextTokenBudget?: number;
  permissions?: GranularPermissionEngine;
  onQuestion?: QuestionHandler;
}

export interface PromptSnapshot {
  system: string;
  style: "full" | "compact";
  toolCount: number;
  availableSkills: number;
  activeSkills: string[];
  skillMentions: string[];
  capturedAt: number;
}

const MAX_OUTPUT_LIMIT_CONTINUES = 2;
const MAX_SUBAGENT_TURNS = 40;
/** Background summary starts when the prompt reaches this share of the budget. */
const PRECOMPUTE_SHARE = 0.85;
/** Small sessions compact quickly enough without a background summary. */
const PRECOMPUTE_MIN_TOKENS = 64_000;
const CONTINUE_AFTER_OUTPUT_LIMIT =
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces and continue.";
const FINAL_STEP_REMINDER = [
  "This is the final step of this turn.",
  "Tools are unavailable now.",
  "Summarize what changed, what remains, and the next action.",
  "Do not ask to continue automatically.",
].join(" ");
const FINAL_STEP_FALLBACK =
  "The step budget is exhausted, so I stopped before running another tool. The work above is what completed in this turn. Send another message to continue.";
const BUDGET_WARNING =
  "You are near the turn budget. Finish the current check, then summarize what changed and what remains. Do not start new work.";

/** Longest reasoning block that may stand in for a missing answer. */
const MAX_REASONING_ANSWER_CHARS = 4000;
const REASONING_ONLY_MESSAGE =
  "The model produced only internal reasoning and no answer. Retry, or lower the thinking effort for this model.";

const PROFILE_MODES: Record<AgentProfile, AgentMode> = {
  "orchivox-main": "build",
  "orchivox-plan": "plan",
  "orchivox-ultrawork": "ultrawork",
};

/** `/skill:<name> [args]` forces a skill, like the portable skill command. */
const SKILL_DIRECTIVE = /^\/skill:([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/;

/** Extra attempts when a provider fails before producing any output. */
const MAX_TURN_RETRIES = 1;

const STUDY_NUDGE = [
  "You have some tool results. If you need more information, call more read, search, or command tools now.",
  "Do not write code or a plan. When you have enough, write the project report.",
  "Start with what the project is. Include main modules, architecture, and how to run and test it.",
  "Do not greet. Do not list every file you read. Do not describe agent instructions, skills, tool policy, or internal gates.",
  "Reply in the user's language.",
].join(" ");

const REVIEW_NUDGE = [
  "Answer the review question now using the tool results.",
  "Start with the answer. Do not rewrite files unless the user asked for a fix.",
].join(" ");

const MIN_STUDY_ANSWER_CHARS = 40;

const SUBAGENT_BLOCKED_TOOLS = new Set([
  "spawn_subagents",
  "task_create",
  "task_dispatch",
  "task_cancel",
  "task_merge",
  "task_wait",
  "question",
  "write_plan",
]);

/** Upper bound for independent read-only tools running in one batch. */
const MAX_CONCURRENT_TOOLS = 4;

interface ToolBatch {
  mode: "parallel" | "sequential";
  calls: ToolUseBlock[];
}

interface InstructionStore {
  getInstructionState?: (sessionId: string) => InstructionState | undefined;
  saveInstructionState?: (sessionId: string, state: InstructionState) => void;
  loadInstructionMessages?: (sessionId: string) => Message[];
}

/**
 * Groups adjacent independent reads into one batch. A lone read stays
 * sequential because a batch of one gains nothing.
 */
export function partitionToolBatches(
  toolUses: readonly ToolUseBlock[],
  isConcurrentSafe: (name: string) => boolean,
): ToolBatch[] {
  const batches: ToolBatch[] = [];
  let pending: ToolUseBlock[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    batches.push({ mode: pending.length > 1 ? "parallel" : "sequential", calls: pending });
    pending = [];
  };
  for (const block of toolUses) {
    if (isConcurrentSafe(block.name)) {
      pending.push(block);
      continue;
    }
    flush();
    batches.push({ mode: "sequential", calls: [block] });
  }
  flush();
  return batches;
}

/** Runs tasks up to the limit, then rethrows the first failure. */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const failures: unknown[] = [];
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (failures.length === 0) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        try {
          await run(items[index], index);
        } catch (error) {
          failures.push(error);
          return;
        }
      }
    }),
  );
  if (failures.length > 0) throw failures[0];
}

export class AgentOrchestrator implements IAgentRunner {
  readonly todos = new TodoEngine();
  readonly hooks: HookRunner;
  readonly advisor: AdvisorReviewer;
  readonly subagents: SubagentManager;
  readonly permissions: GranularPermissionEngine;
  readonly registry: ToolRegistry;
  readonly customCommands: CustomCommandEngine;
  readonly specialistAgents: SpecialistAgentRegistry;
  readonly bgProcesses: BackgroundProcessManager;
  readonly skills: SkillRegistry;
  readonly tasks: TaskBoard;

  private readonly router: ProviderRouter;
  private readonly snapshots: SnapshotManager;
  private readonly rules: RulesLoader;
  private readonly database: MemoryDatabase;
  private readonly ephemeralSkills = new Set<string>();
  private readonly lastPrompts = new Map<string, PromptSnapshot>();
  private readonly lastTurnMetrics = new Map<string, TurnMetrics>();
  private readonly webSearchSessions = new Map<string, WebSearchSession>();
  private readonly lastSkillReload = new Map<string, number>();
  private readonly precomputedCompactions = new Map<string, PrecomputedCompaction>();
  private readonly precomputeInFlight = new Map<string, Promise<void>>();
  private readonly hindsight: HindsightMemory;
  private readonly lsp: LSPClient | undefined;
  private readonly hashEditLifecycle: HashlineLifecycle | undefined;
  private readonly root: string;
  private readonly maxTurns: number;
  private readonly contextTokenBudget: number;
  private readonly compactionConfig: CompactionConfig;
  private readonly webSearchConfig: WebSearchConfig;
  private readonly webFetchConfig: WebFetchConfig;
  private readonly promptStyle: "auto" | "full" | "compact";
  private readonly config: AppConfig | undefined;
  private readonly maxSilentReasoningChars: number;
  private readonly maxSilentReasoningSeconds: number;
  private readonly maxTurnTokens: number | undefined;
  private readonly maxRequestBytes: number;
  private readonly skillMaxBodyChars: number;
  private branch: string | undefined;
  private globalRules = "";
  private projectContext: ProjectContext | undefined;
  private readonly taskRequests = new Map<string, AgentTaskRequest>();
  private readonly pendingDiagnostics = new Map<string, string>();
  private questionHandler: QuestionHandler | undefined;
  private requestedModeSwitch: AgentMode | undefined;

  constructor(options: AgentOrchestratorOptions) {
    this.router = options.router;
    this.snapshots = options.snapshots;
    this.rules = options.rules;
    this.database = options.database;
    this.lsp = options.lsp;
    this.hashEditLifecycle = options.hashEditLifecycle;
    this.root = options.repoRoot ?? globalThis.process.cwd();
    this.maxTurns = options.maxTurns ?? 0;
    this.contextTokenBudget = options.contextTokenBudget ?? 200_000;
    this.compactionConfig =
      options.config?.compaction ?? {
        auto: true,
        keep_tokens: 15_000,
        buffer: "15%",
        precompute: false,
        prune: false,
        prune_protect_tokens: 40_000,
        prune_min_tokens: 20_000,
      };
    this.webSearchConfig = options.config?.websearch ?? {
      enabled: true,
      provider: "random",
      max_results: 8,
    };
    this.webFetchConfig = options.config?.webfetch ?? { enabled: true, max_chars: 24_000 };
    this.promptStyle = options.config?.prompt?.style ?? "auto";
    this.config = options.config;
    this.maxSilentReasoningChars = options.config?.reasoning?.max_silent_chars ?? 0;
    this.maxSilentReasoningSeconds = options.config?.reasoning?.max_silent_seconds ?? 180;
    this.maxTurnTokens = options.config?.limits?.turn_tokens;
    this.maxRequestBytes = options.config?.limits?.max_request_bytes ?? 0;
    this.skillMaxBodyChars = options.config?.skills?.max_body_chars ?? 0;
    this.permissions = options.permissions ?? new GranularPermissionEngine({ repoRoot: this.root });
    this.questionHandler = options.onQuestion;
    this.registry = new ToolRegistry({ permissions: this.permissions });
    this.hindsight = new HindsightMemory(options.database);
    this.hooks = new HookRunner({ hooks: options.config?.hooks, cwd: this.root });
    this.advisor = new AdvisorReviewer({ router: options.router, repoRoot: this.root });
    this.customCommands = new CustomCommandEngine({ repoRoot: this.root });
    this.specialistAgents = new SpecialistAgentRegistry({ repoRoot: this.root });
    this.skills = new SkillRegistry({ repoRoot: this.root, maxBodyChars: this.skillMaxBodyChars });
    this.bgProcesses = new BackgroundProcessManager({ defaultCwd: this.root });
    this.subagents = new SubagentManager({
      worktrees: options.worktrees,
      executor: (input) => this.executeSubagent(input),
    });
    this.tasks = new TaskBoard({
      spawner: (input) => this.spawnTaskWorker(input),
      canceller: (workerId) => this.subagents.kill(workerId),
      merger: (workerId) => options.worktrees.mergeAndCleanup(workerId),
      maxConcurrent: 3,
      maxTasks: options.config?.limits?.max_workers_per_turn ?? 10,
      store: options.database,
    });
    this.registerDefaultTools();
  }

  /**
   * Asks the running turn to continue in another mode, for example after the
   * user picks build in a plan-to-build handoff question. The turn switches at
   * the next tool boundary so the tool gate, not just the next turn, unlocks.
   */
  requestModeSwitch(mode: AgentMode): void {
    this.requestedModeSwitch = mode;
  }

  private consumeModeSwitch(): AgentMode | undefined {
    const next = this.requestedModeSwitch;
    this.requestedModeSwitch = undefined;
    return next;
  }

  /**
   * Local runtimes stay sequential unless the profile opts in with
   * parallel_tool_calls, because small local models emit tool calls one at a
   * time and interleave their results poorly.
   */
  private prefersSequentialTools(provider: string | undefined, model: string | undefined): boolean {
    if (!provider) return true;
    const explicit = model
      ? this.config?.providers[provider]?.model_capabilities?.[model]?.parallel_tool_calls
      : undefined;
    if (explicit !== undefined) return !explicit;
    return this.router.providerKind(provider) === "ollama";
  }

  setQuestionHandler(handler: QuestionHandler | undefined): void {
    this.questionHandler = handler;
  }

  async initialize(): Promise<PluginLoadReport> {
    await this.customCommands.loadCommands({ reset: true });
    await this.specialistAgents.ensureDefaults();
    await this.skills.load(true);
    this.globalRules = await this.rules.getGlobalRules();
    this.projectContext = await loadProjectContext(this.root);
    const branch = await runGit(this.root, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
    this.branch = branch.exitCode === 0 ? branch.stdout.trim() || undefined : undefined;
    return this.hooks.loadUserPlugins(this.registry);
  }

  /**
   * Re-reads the files that shape a turn: skills, commands, agents, project
   * rules, and the project summary. Plugins are registered at startup and need
   * a restart because their modules are cached and their tools are already
   * registered.
   */
  async reload(): Promise<ReloadReport> {
    const [skills, commands, agents] = await Promise.all([
      this.skills.load(true),
      this.customCommands.loadCommands({ reset: true }),
      this.specialistAgents.loadAgents(),
    ]);
    // The rules loader remembers which files it already injected, so a reload
    // has to forget them before it reads AGENTS.md again.
    this.rules.reset();
    this.globalRules = await this.rules.getGlobalRules();
    this.projectContext = await loadProjectContext(this.root);
    const branch = await runGit(this.root, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
    this.branch = branch.exitCode === 0 ? branch.stdout.trim() || undefined : undefined;
    return {
      skills: skills.length,
      commands: commands.size,
      agents: agents.size,
      rules: this.globalRules.trim().length > 0,
      projectContext: this.projectContext !== undefined,
    };
  }

  private instructionStore(): InstructionStore {
    return this.database as unknown as InstructionStore;
  }

  private supportsInstructionState(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    const store = this.instructionStore();
    return (
      typeof store.getInstructionState === "function" &&
      typeof store.saveInstructionState === "function" &&
      typeof store.loadInstructionMessages === "function"
    );
  }

  private loadInstructionState(sessionId: string | undefined): InstructionState | undefined {
    if (!sessionId) return undefined;
    const store = this.instructionStore();
    if (typeof store.getInstructionState !== "function") return undefined;
    try {
      return store.getInstructionState(sessionId);
    } catch {
      return undefined;
    }
  }

  private saveInstructionState(sessionId: string | undefined, state: InstructionState): void {
    if (!sessionId) return;
    const store = this.instructionStore();
    if (typeof store.saveInstructionState !== "function") return;
    try {
      store.saveInstructionState(sessionId, state);
    } catch {
      // A read-only or stub database must not break the turn.
    }
  }

  private loadInstructionMessages(sessionId: string | undefined): Message[] {
    if (!sessionId) return [];
    const store = this.instructionStore();
    if (typeof store.loadInstructionMessages !== "function") return [];
    try {
      return store.loadInstructionMessages(sessionId);
    } catch {
      return [];
    }
  }

  estimateContextOverhead(mode: AgentMode): number {
    const compact = this.useCompactPrompt();
    const providerRef = this.router.getModeModel(mode);
    const capabilities = providerRef ? this.router.capabilitiesForMode(mode) : undefined;
    const tools = this.filterToolsForCapabilities(
      filterToolsForMode(this.registry.listDefinitions(), mode),
      capabilities,
    );
    const promptBase = {
      mode,
      providerKind: providerRef?.provider ? this.router.providerKind(providerRef.provider) : undefined,
      model: providerRef?.model,
      modelName: providerRef?.model,
      repoRoot: this.root,
      branch: this.branch,
      agentInstructions: this.globalRules,
      projectSummary: this.projectContext?.summary,
      skillsIndex: this.skills.buildIndexPrompt({ compact }),
      compact,
      includeInstructions: false,
      includeClosing: false,
      tools: tools.map((tool) => tool.name),
    };
    const system = buildSystemParts(promptBase)
      .map((part) => part.text)
      .join("\n\n");
    const instructionTokens = instructionBlocks(promptBase).reduce(
      (sum, block) => sum + estimateTextTokens(block.text),
      0,
    );
    return estimateTextTokens(system) + estimateToolsTokens(tools) + instructionTokens;
  }

  getLastPromptInfo(sessionId?: string): PromptSnapshot | undefined {
    return sessionId ? this.lastPrompts.get(sessionId) : undefined;
  }

  getLastTurnMetrics(sessionId?: string): TurnMetrics | undefined {
    return sessionId ? this.lastTurnMetrics.get(sessionId) : undefined;
  }

  async runOnce(request: AgentRunRequest): Promise<AgentRunResult> {
    return this.execute(request, undefined, () => undefined);
  }

  async *runStream(request: AgentRunRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
    const queue: StreamEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    const sink = (event: StreamEvent): void => {
      queue.push(event);
      wake?.();
    };
    const run = this.execute(request, signal, sink)
      .then(() => {
        finished = true;
        wake?.();
      })
      .catch((error: unknown) => {
        sink({
          type: "error",
          code: "orchestrator_failed",
          message: error instanceof Error ? error.message : String(error),
          recoverable: false,
        });
        sink({ type: "done", finish_reason: "error" });
        finished = true;
        wake?.();
      });

    while (!finished || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
        continue;
      }
      yield queue.shift() as StreamEvent;
    }
    await run;
  }

  async startTask(request: AgentTaskRequest): Promise<AgentTask> {
    const worker = this.subagents.spawnOne({
      task: request.task,
      writeIsolation: true,
      onComplete: (state) => {
        if (!request.webhook_url) return;
        void this.postWebhook(request.webhook_url, state, request);
      },
    });
    this.taskRequests.set(worker.id, request);
    return this.toAgentTask(worker, request);
  }

  async getTask(id: string): Promise<AgentTask | undefined> {
    const worker = this.subagents.getWorker(id);
    if (!worker) return undefined;
    return this.toAgentTask(worker, this.taskRequests.get(id));
  }

  private registerDefaultTools(): void {
    const lifecycle: HashlineLifecycle = {
      onBeforeModify: async (filePath) => {
        await this.hashEditLifecycle?.onBeforeModify?.(filePath);
      },
      onAfterModify: async (filePath, newContent) => {
        if (this.hashEditLifecycle?.onAfterModify) {
          await this.hashEditLifecycle.onAfterModify(filePath, newContent);
          return;
        }
        const diagnostics = await this.collectDiagnostics(filePath, newContent);
        if (diagnostics) this.pendingDiagnostics.set(filePath, diagnostics);
      },
    };

    this.registry.register(createReadFileTool());
    this.registry.register(createReadDocumentTool({ config: this.config?.documents }));
    this.registry.register(createWritePlanTool({ repoRoot: this.root }));
    this.registry.register(
      createQuestionTool(async (request) => {
        if (!this.questionHandler) {
          throw new Error("The question tool is unavailable in this client.");
        }
        return this.questionHandler(request);
      }),
    );
    this.registry.register(createHashEditTool(lifecycle));
    this.registry.register(createReplaceTextTool(lifecycle));
    this.registry.register(createCreateFileTool(lifecycle, { repoRoot: this.root }));
    this.registry.register(createDeleteFileTool(lifecycle));
    this.registry.register(createMoveFileTool(lifecycle));
    this.registry.register(createApplyUnifiedPatchTool(lifecycle));
    const searchTimeoutMs = (this.config?.tools?.search_timeout_seconds ?? 30) * 1000;
    this.registry.register(
      createGlobFilesTool({
        maxResults: this.config?.tools?.glob_limit,
        timeoutMs: searchTimeoutMs,
      }),
    );
    this.registry.register(
      createGrepSearchTool({
        maxResults: this.config?.tools?.grep_limit,
        timeoutMs: searchTimeoutMs,
      }),
    );
    const codeMode = this.config?.tools?.code_mode ?? "off";
    if (codeMode !== "off") {
      this.registry.register(
        createSandboxScriptTool(this.registry, {
          root: this.root,
          name: "execute",
          mode: codeMode,
          timeoutMs: 30_000,
        }),
      );
    }
    this.registry.register(createDiffViewTool());
    this.registry.register(createJsonQueryTool());
    this.registry.register(new PersistentShellTool({ cwd: this.root }));
    registerAstTools(this.registry);
    this.todos.registerTools(this.registry);
    this.subagents.registerTools(this.registry);
    this.skills.registerTools(this.registry);
    this.tasks.registerTools(this.registry);
    this.hindsight.registerTools(this.registry);
    this.registry.register(createDiagnosticsCheckTool({ lsp: this.lsp, repoRoot: this.root }));
    this.bgProcesses.registerTools(this.registry);
    this.registry.register(
      createInspectImageTool({
        router: this.router,
        repoRoot: this.root,
        config: this.config?.documents?.image,
      }),
    );
    registerWebTools(this.registry, {
      search: this.webSearchConfig,
      fetch: this.webFetchConfig,
      getSession: () => {
        const sessionId = currentTurnContext()?.sessionId;
        if (!sessionId) return undefined;
        let session = this.webSearchSessions.get(sessionId);
        if (!session) {
          session = {};
          this.webSearchSessions.set(sessionId, session);
        }
        return session;
      },
    });
    registerCodeIntelTools(this.registry, { lsp: this.lsp, repoRoot: this.root });
    if (this.lsp) this.lsp.registerTools(this.registry);
  }

  private async execute(
    request: AgentRunRequest,
    signal: AbortSignal | undefined,
    sink: (event: StreamEvent) => void,
  ): Promise<AgentRunResult> {
    const mode = PROFILE_MODES[request.profile];
    const sessionId = typeof request.metadata?.session_id === "string" ? request.metadata.session_id : undefined;
    return runWithTurnContext({ mode, sessionId }, () =>
      this.executeInner(request, signal, sink, mode),
    );
  }

  private async executeInner(
    request: AgentRunRequest,
    signal: AbortSignal | undefined,
    rawSink: (event: StreamEvent) => void,
    mode: AgentMode,
  ): Promise<AgentRunResult> {
    const sessionId = typeof request.metadata?.session_id === "string" ? request.metadata.session_id : undefined;
    // Ids are stored in the session database, so every run needs its own prefix
    // or a second user turn would reuse turn-0 and collide.
    const runId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const metrics = new TurnMetricsTracker();
    let totals: Usage = zeroUsage();
    const configuredSteps = this.config?.modes?.[mode]?.steps;
    const stepLimit = modeStepLimit(mode, configuredSteps, this.maxTurns);
    const toolLimit = this.config?.limits?.max_tool_calls ?? 0;
    const wallLimitMs = (this.config?.limits?.max_wall_seconds ?? 0) * 1000;
    const webSearchLimit = this.config?.limits?.max_web_searches ?? 0;
    const maxRepeatedCalls = this.config?.limits?.max_repeated_calls ?? 0;
    const toolCallTracker = new ToolCallTracker(maxRepeatedCalls);
    const readFileCache = new ReadFileCache();
    let budgetWarned = false;
    let toolBudgetExhausted = false;
    let webSearchCalls = 0;
    const sink = (event: StreamEvent): void => {
      switch (event.type) {
        case "step_started":
          metrics.recordStep();
          break;
        case "tool_start":
          metrics.recordTool(event.name);
          break;
        case "compaction":
          metrics.recordCompaction({
            trigger:
              event.trigger ??
              (event.reason === "request_size"
                ? "request_size"
                : event.reason === "retry"
                  ? "overflow"
                  : event.reason === "output_limit"
                    ? "output_limit"
                    : event.reason === "manual"
                      ? "manual"
                      : "tokens"),
            before_tokens: event.before_tokens,
            after_tokens: event.after_tokens,
            request_bytes: event.request_bytes,
            max_request_bytes: event.max_request_bytes,
            input_budget: event.input_budget,
            buffer_tokens: event.buffer_tokens,
          });
          break;
        case "context_pruned":
          metrics.recordPrune();
          break;
        case "done": {
          const snapshot = metrics.snapshot({
            usage: totals,
            finishReason: event.finish_reason,
            stepLimit: stepLimit > 0 ? stepLimit : undefined,
            toolLimit: toolLimit > 0 ? toolLimit : undefined,
            timeLimitMs: wallLimitMs > 0 ? wallLimitMs : undefined,
          });
          this.lastTurnMetrics.set(sessionId ?? runId, snapshot);
          rawSink({ ...event, metrics: snapshot });
          return;
        }
        default:
          break;
      }
      rawSink(event);
    };

    let activeSpecialist: SpecialistAgentProfile | undefined;
    if (typeof request.metadata?.agent === "string") {
      activeSpecialist = await this.specialistAgents.getAgent(request.metadata.agent as string);
    }

    let messages: Message[] = [...request.messages];
    let contract = modeContract(mode);
    const persistedIds = new Set<string>();
    const useInstructionState = this.supportsInstructionState(sessionId);
    let instructionState: InstructionState | undefined = useInstructionState
      ? this.loadInstructionState(sessionId)
      : undefined;
    if (useInstructionState) {
      messages = mergeInstructionMessages(messages, this.loadInstructionMessages(sessionId));
    }

    let lastUserIdx = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "user" && !isSyntheticMessage(message)) {
        lastUserIdx = index;
        break;
      }
    }
    if (lastUserIdx !== -1) {
      const userMsg = messages[lastUserIdx];
      const textBlock = userMsg.content.find((b) => b.type === "text");
      if (textBlock && textBlock.type === "text") {
        const trimmed = textBlock.text.trim();
        if (trimmed.startsWith("/")) {
          const spaceIdx = trimmed.indexOf(" ");
          const cmdName = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).trim();
          const rawArgs = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
          const expanded = await this.customCommands.executeCommand(cmdName, rawArgs);
          if (expanded) {
            textBlock.text = expanded.prompt;
            if (expanded.agent && !request.metadata?.agent) {
              activeSpecialist = await this.specialistAgents.getAgent(expanded.agent);
            }
          }
        }
      }
    }

    const lastUserMsg = [...messages]
      .reverse()
      .find((message) => message.role === "user" && !isSyntheticMessage(message));
    let lastText =
      lastUserMsg?.content.map((b) => (b.type === "text" ? b.text : "")).join(" ") ?? "";

    // `/skill:<name> [args]` forces a skill and turns the rest of the line into
    // the request, so the model follows the skill instead of reading the command.
    let forcedSkill: SkillDocument | undefined;
    const skillDirective = SKILL_DIRECTIVE.exec(lastText.trim());
    if (skillDirective && lastUserMsg) {
      const document = this.skills.get(skillDirective[1]);
      if (document) {
        forcedSkill = document;
        const args = (skillDirective[2] ?? "").trim();
        const replacement =
          args.length > 0 ? args : `Follow the ${document.name} skill for this request.`;
        const content = lastUserMsg.content.map((block) =>
          block.type === "text" ? { ...block, text: replacement } : block,
        );
        messages = messages.map((message) =>
          message.id === lastUserMsg.id ? { ...message, content } : message,
        );
        lastText = replacement;
      }
    }

    const turnContext = currentTurnContext();
    if (turnContext) {
      turnContext.userText = lastText;
      turnContext.forcedSkills = forcedSkill ? [forcedSkill.name] : [];
    }

    if (!activeSpecialist && lastText) {
      const mention = await this.specialistAgents.parseMention(lastText);
      if (mention?.profile) {
        activeSpecialist = mention.profile;
      }
    }

    const requestedRole: "main" | "fast" | "advisor" | undefined =
      activeSpecialist?.roleModel === "advisor" ||
      activeSpecialist?.roleModel === "fast" ||
      activeSpecialist?.roleModel === "main"
        ? activeSpecialist.roleModel
        : undefined;
    const provider = requestedRole ? this.router.get(requestedRole) : this.router.getMode(mode);
    const providerRef = requestedRole ? this.router.getRole(requestedRole) : this.router.getModeModel(mode);
    const capabilities = requestedRole
      ? this.router.capabilitiesForRole(requestedRole)
      : this.router.capabilitiesForMode(mode);
    const promptProviderKind = providerRef?.provider
      ? this.router.providerKind(providerRef.provider)
      : undefined;
    if (!capabilities.vision) messages = stripImageBlocks(messages);

    const compact = this.useCompactPrompt();
    const mentionedSkills = lastText ? parseSkillMentions(lastText, this.skills) : [];
    if (forcedSkill && !mentionedSkills.some((entry) => entry.name === forcedSkill?.name)) {
      mentionedSkills.unshift(forcedSkill);
    }
    for (const document of mentionedSkills) {
      const newlyActivated = this.activateSkill(sessionId, document.name);
      if (newlyActivated) {
        sink({
          type: "skill_activated",
          name: document.name,
          allowed_tools: document.allowedTools ?? [],
          trigger: "mention",
        });
      }
    }
    // Name matching is provider-independent on purpose: the same request loads
    // the same skills whatever model answers it.
    const namedSkills = lastText ? matchSkillNames(lastText, this.skills) : [];
    const loadedSkills = loadedSkillIds(messages);
    const turnSkills = [
      ...new Map(
        [...mentionedSkills, ...namedSkills].map((document) => [document.name, document]),
      ).values(),
    ];
    for (const document of turnSkills) {
      const newlyActivated = this.activateSkill(sessionId, document.name);
      if (newlyActivated) {
        sink({
          type: "skill_activated",
          name: document.name,
          allowed_tools: document.allowedTools ?? [],
          trigger: mentionedSkills.includes(document) ? "mention" : "auto",
        });
      }
    }
    const skillHint = buildSkillHint({
      forcedSkill: forcedSkill?.name,
      mentionedSkills: mentionedSkills.map((document) => document.name),
      namedSkills: namedSkills.map((document) => document.name),
      loadedSkills,
    });

    const contextWindowBase = effectiveContextWindow(capabilities) ?? this.contextTokenBudget;
    let contextWindow = contextWindowBase;
    const refreshContextWindow = (): number => {
      if (!providerRef?.provider) return contextWindow;
      try {
        const fresh = this.router.capabilitiesFor(providerRef.provider, providerRef.model);
        return effectiveContextWindow(fresh) ?? contextWindow;
      } catch {
        return contextWindow;
      }
    };
    const loadedSkillDocs = this.activeSkillDocuments(sessionId);
    await this.reloadSkillsAfterCompaction(sessionId, messages);
    const activeSkillDocs = loadedSkillDocs.filter(
      (document) => !turnSkills.some((turnSkill) => turnSkill.name === document.name),
    );
    let tools = this.filterToolsForCapabilities(
      this.combineTools(request.tools, mode),
      capabilities,
    );
    if (!capabilities.tool_calling) tools = [];
    if (activeSpecialist) {
      tools = this.specialistAgents.filterTools(activeSpecialist, tools, this.readOnlyToolNames());
    }
    const promptBase = {
      mode,
      task: request.task,
      providerKind: promptProviderKind,
      model: providerRef?.model,
      modelName: providerRef?.model,
      repoRoot: this.root,
      branch: this.branch,
      agentInstructions: this.globalRules,
      specialistPrompt: activeSpecialist?.systemPrompt,
      projectSummary: this.projectContext?.summary,
      skillsIndex: this.skills.buildIndexPrompt({ compact }),
      extra: request.system,
      compact,
      includeInstructions: !useInstructionState,
      includeClosing: false,
      tools: tools.map((tool) => tool.name),
    };
    const systemParts = buildSystemParts(promptBase);
    const system = systemParts.map((part) => part.text).join("\n\n");
    const ensureInstructions = (): void => {
      if (!useInstructionState) return;
      const plan = planInstructionUpdates({
        blocks: instructionBlocks(promptBase),
        messages,
        state: instructionState,
      });
      if (plan.updates.length > 0) {
        const additions = plan.updates.map((update, index) =>
          instructionMessage(`${runId}-instruction-${index}-${update.key}`, update),
        );
        insertBeforeLastUser(messages, additions);
        for (const message of additions) {
          try {
            this.database.saveMessage(sessionId as string, message);
            persistedIds.add(message.id);
          } catch {
            // Instruction persistence is best effort; the next turn re-injects it.
          }
        }
      }
      instructionState = plan.nextState;
      this.saveInstructionState(sessionId, plan.nextState);
    };
    const ensurePlanReminder = (): void => {
      const enter = planEnterReminder();
      const leave = planLeaveReminder();
      const last = lastPlanReminder(messages, enter, leave);
      const text =
        mode === "plan"
          ? last === enter
            ? undefined
            : enter
          : last === enter
            ? leave
            : undefined;
      if (!text) return;
      const message = {
        ...makeMessage(`${runId}-plan-${mode}`, "user", text),
        metadata: { synthetic: true, planReminder: true },
      };
      insertBeforeLastUser(messages, [message]);
      if (sessionId) {
        try {
          this.database.saveMessage(sessionId, message);
          persistedIds.add(message.id);
        } catch {
          // Plan reminder persistence is best effort.
        }
      }
    };
    const ensureDynamicMessages = (): void => {
      ensureInstructions();
      ensurePlanReminder();
    };
    ensureDynamicMessages();
    appendSyntheticMessage(messages, `${runId}-context`, request.context);
    appendSyntheticMessage(messages, `${runId}-skill-hint`, skillHint);
    appendSyntheticMessage(
      messages,
      `${runId}-closing`,
      closingReminder({ task: request.task }),
    );
    const overheadTokens = estimateTextTokens(system) + estimateToolsTokens(tools);
    const availableSkillCount = this.skills.listAvailableDocuments().length;
    const mentionedSkillNames = turnSkills.map((document) => document.name);
    const initialActiveSkillNames = [
      ...new Set([...loadedSkillDocs.map((document) => document.name), ...mentionedSkillNames]),
    ];
    const promptStyle = compact ? ("compact" as const) : ("full" as const);
    const capturePrompt = (documents: SkillDocument[]): void => {
      this.rememberPrompt(sessionId, {
        system,
        style: promptStyle,
        toolCount: tools.length,
        availableSkills: availableSkillCount,
        activeSkills: [
          ...new Set([...activeSkillDocs, ...documents].map((document) => document.name)),
        ],
        skillMentions: mentionedSkillNames,
        capturedAt: Date.now(),
      });
    };
    capturePrompt(turnSkills);
    sink({
      type: "prompt_preflight",
      style: promptStyle,
      system_chars: system.length,
      tool_count: tools.length,
      available_skills: availableSkillCount,
      active_skills: initialActiveSkillNames,
      skill_mentions: mentionedSkillNames,
    });

    const skillPolicy = new SkillToolPolicy(SKILL_ALWAYS_ALLOWED_TOOLS);
    const activatedSkills = new Set<string>();
    for (const document of [...loadedSkillDocs, ...turnSkills]) {
      activatedSkills.add(document.name);
      if (document.allowedTools !== undefined) skillPolicy.activate(document.allowedTools);
    }
    let finishReason: FinishReason = "stop";
    let ultraworkNudges = 0;
    let turnRetries = 0;
    let reasoningRecoveries = 0;
    let forceAction = false;
    let taskNudged = false;
    let studyRetried = false;
    // Measured context is everything the last request used: the prompt it sent
    // plus the completion it produced, reasoning included. The assistant message
    // covered by that completion is the last message before the trailing count.
    let measuredContext: { messageCount: number; usedTokens: number } | undefined;
    const precomputeKey = sessionId ?? runId;
    let precomputeEpoch = 0;

    const specialistBudget = activeSpecialist?.thinkingBudget ?? 0;
    const capabilityBudget = capabilities.reasoning ? (capabilities.reasoning_budget_max ?? 8192) : 0;
    const reasoningBudget = Math.max(specialistBudget, capabilityBudget);
    const outputCap = Math.min(capabilities.max_output ?? 32_000, 256_000);
    const defaultOutput = reasoningBudget > 0 ? Math.max(outputCap, reasoningBudget + 2048) : outputCap;
    const requestedMaxTokens = request.max_tokens ?? defaultOutput;
    const inputBase = Math.min(capabilities.max_input ?? contextWindow, contextWindow);
    const bufferTokens = resolveCompactionBuffer(inputBase, {
      buffer: this.compactionConfig.buffer,
      reserved: this.compactionConfig.reserved,
      reserveTokens: this.compactionConfig.reserve_tokens,
      bufferTokens: this.compactionConfig.buffer_tokens,
      bufferRatio: this.compactionConfig.buffer_ratio,
    });
    const inputBudget = computeInputBudget({
      contextWindow,
      maxInput: capabilities.max_input,
      maxOutput: capabilities.max_output,
      requestedOutput: requestedMaxTokens,
      reserved: bufferTokens,
    });
    const estimatePromptTokens = (): number => {
      const estimated =
        messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + overheadTokens;
      if (!measuredContext) return estimated;
      if (measuredContext.messageCount > messages.length) {
        // Usage arrived but the reply it covers was never appended, so the
        // context cannot be smaller than what the provider measured. Compacting
        // early is safer than undercounting.
        return Math.max(measuredContext.usedTokens, estimated);
      }
      let trailingTokens = 0;
      for (let index = measuredContext.messageCount; index < messages.length; index += 1) {
        trailingTokens += estimateMessageTokens(messages[index]);
      }
      return measuredContext.usedTokens + trailingTokens;
    };
    const measuredPromptTokens = (): number | undefined =>
      measuredContext ? estimatePromptTokens() : undefined;
    const outputHeadroom = (): number => {
      const reserve = Math.max(2048, Math.floor(contextWindow * 0.02));
      return Math.max(1024, contextWindow - estimatePromptTokens() - reserve);
    };
    let forcedOutputLimit: number | undefined;
    let maxTokens = Math.max(1024, Math.min(requestedMaxTokens, outputCap, outputHeadroom()));
    let overflowAttempts = 0;
    let compactionFailure: string | undefined;
    const keepTokensForAttempt = (): number => {
      if (overflowAttempts <= 0) return this.compactionConfig.keep_tokens;
      const step =
        OVERFLOW_SHRINK_STEPS[
          Math.min(overflowAttempts - 1, OVERFLOW_SHRINK_STEPS.length - 1)
        ];
      return Math.max(1_000, Math.floor(this.compactionConfig.keep_tokens * step));
    };
    let outputLimitContinues = 0;
    let outputLimitCompacted = false;
    let outputBudgetRetried = false;

    // The database keeps every tool call and its result so a resumed session
    // still has the full conversation. The final text answer is stored by the
    // client with its own display metadata, so it is not stored twice here.
    const persistConversationMessage = (message: Message): void => {
      if (!sessionId) return;
      const hasToolUse = message.content.some((block) => block.type === "tool_use");
      if (message.role === "assistant" && !hasToolUse) return;
      if (message.role !== "assistant" && message.role !== "tool") return;
      const content = message.content.filter((block) => block.type !== "thinking");
      try {
        this.database.saveMessage(sessionId, { ...message, content });
        persistedIds.add(message.id);
      } catch {
        // A deleted session must not break the turn.
      }
    };

    // A compaction tail may start at an internal notice that was never stored.
    // Point it at the first stored message so resume still keeps the tail.
    const persistableTail = (tailId: string | undefined): string | undefined => {
      if (!tailId) return undefined;
      const index = messages.findIndex((message) => message.id === tailId);
      if (index === -1) return undefined;
      for (let cursor = index; cursor < messages.length; cursor += 1) {
        const candidate = messages[cursor];
        if (candidate && persistedIds.has(candidate.id)) return candidate.id;
      }
      return undefined;
    };

    const applyModeSwitch = (next: AgentMode, turn: number): void => {
      if (next === mode) return;
      const from = mode;
      mode = next;
      contract = modeContract(mode);
      tools = this.filterToolsForCapabilities(this.combineTools(request.tools, mode), capabilities);
      if (!capabilities.tool_calling) tools = [];
      if (activeSpecialist) {
        tools = this.specialistAgents.filterTools(activeSpecialist, tools, this.readOnlyToolNames());
      }
      appendSyntheticMessage(
        messages,
        `turn-${turn}-mode`,
        modeTransitionReminder(from, mode),
      );
      ensurePlanReminder();
      sink({ type: "mode_changed", from, to: mode });
    };

    const retryWithCorrection = async (
      originalText: string,
      correction: string[],
    ): Promise<string> => {
      const retryCorrection = ["# Correction", ...correction].join("\n\n");
      const retryParts = [...systemParts, { text: retryCorrection }];
      const retrySystem = retryParts.map((part) => part.text).join("\n\n");
      const retryRequest = ChatRequestSchema.parse({
        system: retrySystem,
        system_parts: retryParts,
        messages: messages.slice(0, -1),
        tools: [],
        tool_choice: "none",
        max_tokens: maxTokens,
        temperature: request.temperature,
        top_p: request.top_p,
        stop_sequences: request.stop_sequences,
        reasoning_effort: capabilities.reasoning
          ? clampReasoningEffort(request.reasoning_effort, capabilities.reasoning_efforts)
          : undefined,
      });
      let text = "";
      let thinking = "";
      try {
        for await (const event of provider.streamChat(retryRequest, signal)) {
          if (event.type === "token") text += event.text;
          else if (event.type === "thinking_token") thinking += event.text;
          else if (event.type === "usage") accumulateUsage(totals, event);
        }
      } catch {
        return sanitizeAssistantText(originalText);
      }
      const candidate =
        stripThinkTags(text).trim().length > 0
          ? stripThinkTags(text).trim()
          : cleanReasoningAnswer(stripThinkTags(thinking));
      return sanitizeAssistantText(candidate);
    };

    const retryAfterInternalDump = async (originalText: string): Promise<string> =>
      retryWithCorrection(originalText, [
        "The previous response leaked internal skill content or an internal gate report.",
        "Answer the user's actual question directly.",
        "Do not print skill bodies, skill file listings, XML wrappers, internal notes, or gate reports.",
        "Use the project evidence and tool results already present in the conversation.",
      ]);

    for (let turn = 0; stepLimit === 0 || turn < stepLimit || toolBudgetExhausted; turn += 1) {
      const finalStep = toolBudgetExhausted || (stepLimit > 0 && turn === stepLimit - 1);
      if (timeBudgetReached(metrics.elapsedMs(), wallLimitMs)) {
        const seconds = Math.round(wallLimitMs / 1000);
        const label = seconds >= 60 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`;
        const notice = `Wall-clock budget reached (${label}). Send another message to continue, or raise limits.max_wall_seconds.`;
        sink({ type: "final_text", text: notice });
        sink(usageEvent(totals, true));
        sink({ type: "done", finish_reason: "turn_limit" });
        return {
          message: makeMessage(`${runId}-time-budget`, "assistant", notice),
          usage: totals,
          finish_reason: "turn_limit",
        };
      }
      const requestedMode = this.consumeModeSwitch();
      if (requestedMode) applyModeSwitch(requestedMode, turn);
      const spentTokens = totals.prompt_tokens + totals.completion_tokens;
      if (turn > 0 && this.maxTurnTokens !== undefined && spentTokens >= this.maxTurnTokens) {
        const notice = `Turn used ${spentTokens} tokens, stopping at the limits.turn_tokens budget of ${this.maxTurnTokens}. Send another message to continue, or raise limits.turn_tokens.`;
        sink({ type: "final_text", text: notice });
        sink(usageEvent(totals, true));
        sink({ type: "done", finish_reason: "turn_limit" });
        return {
          message: makeMessage(`${runId}-turn-${turn}`, "assistant", notice),
          usage: totals,
          finish_reason: "turn_limit",
        };
      }
      let pendingBudgetWarning = false;
      if (!budgetWarned) {
        const warning = turnBudgetWarning({
          steps: turn + 1,
          toolCalls: metrics.toolCallCount,
          elapsedMs: metrics.elapsedMs(),
          limits: { stepLimit, toolLimit, timeLimitMs: wallLimitMs },
        });
        if (warning) {
          budgetWarned = true;
          pendingBudgetWarning = true;
          sink({ type: "turn_budget_warning", ...warning });
        }
      }
      sink({
        type: "step_started",
        step: turn + 1,
        ...(stepLimit > 0 ? { step_limit: stepLimit } : {}),
        tool_calls: metrics.toolCallCount,
        ...(toolLimit > 0 ? { tool_limit: toolLimit } : {}),
        elapsed_ms: metrics.elapsedMs(),
        ...(wallLimitMs > 0 ? { time_limit_ms: wallLimitMs } : {}),
      });
      let compactedThisTurn = false;
      let prunedTokensThisTurn = 0;
      if (this.compactionConfig.prune) {
        const pruned = pruneToolOutput(messages, {
          protectTokens: this.compactionConfig.prune_protect_tokens,
          minTokens: this.compactionConfig.prune_min_tokens,
        });
        if (pruned.prunedResults > 0) {
          messages = pruned.messages;
          ensureDynamicMessages();
          measuredContext = undefined;
          prunedTokensThisTurn = pruned.prunedTokens;
          sink({
            type: "context_pruned",
            tokens: pruned.prunedTokens,
            results: pruned.prunedResults,
            message_ids: pruned.prunedMessageIds,
          });
          if (sessionId) {
            for (const id of pruned.prunedMessageIds) {
              const message = messages.find((entry) => entry.id === id);
              if (!message) continue;
              try {
                this.database.replaceMessageContent(id, message.content);
              } catch {
                // A read-only or stub database must not break the turn.
              }
            }
          }
        }
      }
      const measuredBeforeCompaction = measuredPromptTokens();
      const turnTools = finalStep ? [] : skillPolicy.filter(tools);
      const requestBytes = estimateRequestBytes({ system, messages, tools: turnTools });
      const requestSizeOverLimit =
        this.maxRequestBytes > 0 && requestBytes > this.maxRequestBytes;
      const precomputeThreshold = Math.max(
        PRECOMPUTE_MIN_TOKENS,
        Math.floor(inputBudget * PRECOMPUTE_SHARE),
      );
      if (
        this.compactionConfig.auto &&
        this.compactionConfig.precompute &&
        measuredBeforeCompaction !== undefined &&
        measuredBeforeCompaction >= precomputeThreshold &&
        measuredBeforeCompaction < inputBudget &&
        !this.precomputedCompactions.has(precomputeKey) &&
        !this.precomputeInFlight.has(precomputeKey)
      ) {
        const capturedMessages = messages;
        const capturedEpoch = precomputeEpoch;
        const precompute = precomputeCompaction(capturedMessages, {
          provider,
          contextWindow,
          keepTokens: this.compactionConfig.keep_tokens,
          buffer: this.compactionConfig.buffer,
          reserveTokens: this.compactionConfig.reserve_tokens,
          bufferTokens: this.compactionConfig.buffer_tokens,
          bufferRatio: this.compactionConfig.buffer_ratio,
          overheadTokens,
          previousSummary: extractSummary(capturedMessages),
          signal,
        })
          .then((result) => {
            if (!result || capturedEpoch !== precomputeEpoch) return;
            this.precomputedCompactions.set(precomputeKey, result);
            while (this.precomputedCompactions.size > 32) {
              const oldest = this.precomputedCompactions.keys().next().value;
              if (!oldest) break;
              this.precomputedCompactions.delete(oldest);
            }
          })
          .catch(() => undefined)
          .finally(() => {
            this.precomputeInFlight.delete(precomputeKey);
          });
        this.precomputeInFlight.set(precomputeKey, precompute);
      }
      if (this.compactionConfig.auto) {
        const compaction = await compactMessages(messages, {
          provider,
          contextWindow,
          keepTokens: keepTokensForAttempt(),
          buffer: this.compactionConfig.buffer,
          reserveTokens: this.compactionConfig.reserve_tokens,
          bufferTokens: this.compactionConfig.buffer_tokens,
          bufferRatio: this.compactionConfig.buffer_ratio,
          overheadTokens,
          contextTokens: measuredBeforeCompaction,
          inputBudget,
          force: requestSizeOverLimit || undefined,
          previousSummary: extractSummary(messages),
          precomputed: this.precomputedCompactions.get(precomputeKey),
          onStart: () =>
            sink({
              type: "compaction_start",
              reason: requestSizeOverLimit ? "request_size" : "auto",
            }),
        });
        if (compaction.didCompact) {
          this.precomputedCompactions.delete(precomputeKey);
          precomputeEpoch += 1;
          compactedThisTurn = true;
          measuredContext = undefined;
          messages = compaction.messages;
          ensureDynamicMessages();
          maxTokens =
            forcedOutputLimit ??
            Math.max(1024, Math.min(requestedMaxTokens, outputCap, outputHeadroom()));
          sink({
            type: "compaction",
            reason: requestSizeOverLimit ? "request_size" : "auto",
            trigger: requestSizeOverLimit ? "request_size" : "tokens",
            before_tokens: compaction.beforeTokens,
            after_tokens: compaction.afterTokens,
            summary_tokens: compaction.summaryTokens,
            summary: compaction.summary,
            removed_messages: compaction.removedMessages,
            tail_start_message_id: persistableTail(compaction.tailStartMessageId),
            request_bytes: requestBytes,
            max_request_bytes: this.maxRequestBytes,
            input_budget: inputBudget,
            buffer_tokens: bufferTokens,
          });
          if (sessionId) {
            const compactedAt = Date.now();
            try {
              this.database.saveCompaction(sessionId, {
                summary: compaction.summary ?? "",
                tail_start_message_id: persistableTail(compaction.tailStartMessageId),
                before_tokens: compaction.beforeTokens,
                after_tokens: compaction.afterTokens,
                created_at: compactedAt,
                removed_messages: compaction.removedMessages,
                auto: true,
              });
            } catch {
              // A deleted session must not break the turn.
            }
            this.appendSkillReload(sessionId, messages, compactedAt);
          }
        }
      }

      const advisorNote = this.advisor.consumeNote();
      if (advisorNote) {
        sink({ type: "advisor_note", note: advisorNote, severity: "info" });
        messages.push(makeMessage(`turn-${turn}-advisor`, "system", advisorNote));
      }

      if (pendingBudgetWarning) {
        appendSyntheticMessage(messages, `turn-${turn}-budget`, BUDGET_WARNING);
      }
      if (finalStep && turn > 0) {
        appendSyntheticMessage(messages, `turn-${turn}-final`, FINAL_STEP_REMINDER);
      }

      sink({
        type: "context_estimate",
        tokens: estimatePromptTokens(),
        request_bytes: estimateRequestBytes({ system, messages, tools: turnTools }),
        input_budget: inputBudget,
        context_window: contextWindow,
        max_request_bytes: this.maxRequestBytes,
        buffer_tokens: bufferTokens,
      });

      const requestMessageCount = messages.length;
      const forceActionRequest = forceAction;
      forceAction = false;
      const chatRequest = ChatRequestSchema.parse({
        system,
        system_parts: systemParts,
        messages,
        tools: turnTools,
        tool_choice: turnTools.length > 0 ? request.tool_choice.mode : "none",
        max_tokens: maxTokens,
        temperature: request.temperature,
        top_p: request.top_p,
        stop_sequences: request.stop_sequences,
        reasoning_effort: capabilities.reasoning
          ? clampReasoningEffort(
              forceActionRequest ? "none" : request.reasoning_effort,
              capabilities.reasoning_efforts,
            )
          : undefined,
      });

      const requestEstimate = estimatePromptTokens();
      const accumulator = new TurnAccumulator();
      let turnError: string | undefined;
      let turnErrorCode: string | undefined;
      let contextOverflow = false;
      let errorSunk = false;
      let silentReasoningChars = 0;
      let reasoningStalled = false;
      let timeStalled = false;
      let lastUsage: UsageEvent | undefined;
      const progressController = new AbortController();
      const providerSignal = signal
        ? AbortSignal.any([signal, progressController.signal])
        : progressController.signal;
      let progressTimer: ReturnType<typeof setTimeout> | undefined;
      const resetProgress = (): void => {
        if (progressTimer) clearTimeout(progressTimer);
        progressTimer = setTimeout(() => {
          timeStalled = true;
          progressController.abort();
        }, this.maxSilentReasoningSeconds * 1000);
      };
      resetProgress();
      try {
      for await (const event of provider.streamChat(chatRequest, providerSignal)) {
        switch (event.type) {
          case "token":
            silentReasoningChars = 0;
            resetProgress();
            accumulator.addText(event.text);
            sink(event);
            break;
          case "thinking_token":
            silentReasoningChars += event.text.length;
            // Reasoning is progress. The time guard only catches a provider
            // that stops sending events entirely.
            resetProgress();
            accumulator.addThinking(event.text, event.signature);
            sink(event);
            if (
              this.maxSilentReasoningChars > 0 &&
              silentReasoningChars > this.maxSilentReasoningChars
            ) {
              reasoningStalled = true;
            }
            break;
          case "tool_call_delta":
            silentReasoningChars = 0;
            resetProgress();
            accumulator.addDelta(event);
            sink(event);
            break;
          case "tool_call_ready":
            silentReasoningChars = 0;
            resetProgress();
            accumulator.finishTool(event);
            sink(event);
            break;
          case "usage":
            lastUsage = event;
            accumulateUsage(totals, event);
            // Forward per-request usage so the status meter reflects the latest
            // request instead of the whole turn.
            sink({ ...event, turn_total: false });
            if (event.prompt_tokens > 0) {
              measuredContext = {
                // The assistant reply is appended right after this request.
                messageCount: requestMessageCount + 1,
                usedTokens: event.prompt_tokens + event.completion_tokens,
              };
            }
            break;
          case "retry_scheduled":
            sink(event);
            break;
          case "error": {
            turnError = event.message;
            turnErrorCode = event.code;
            if (isContextOverflow(event.message, event.code)) contextOverflow = true;
            // A recovered provider failure restarts the turn only when nothing was
            // streamed yet, so the transcript never contains a half answer.
            const canRetryTurn =
              event.recoverable === true &&
              !accumulator.hasOutput() &&
              !contextOverflow &&
              turnRetries < MAX_TURN_RETRIES;
            if (!isAutoHandledProviderError(event.message) && !canRetryTurn) {
              sink(event);
              errorSunk = true;
            }
            break;
          }
          case "done":
            finishReason = event.finish_reason;
            break;
          case "rule_violation":
            sink(event);
            break;
          default:
            break;
        }
        if (reasoningStalled || timeStalled) break;
      }
      } finally {
        if (progressTimer) clearTimeout(progressTimer);
      }

      if (usageLogEnabled()) {
        // Await the tiny append so a headless run does not exit before the line
        // reaches disk. appendUsageLog catches its own errors.
        const metricsSnapshot = metrics.snapshot({
          usage: totals,
          stepLimit: stepLimit > 0 ? stepLimit : undefined,
          toolLimit: toolLimit > 0 ? toolLimit : undefined,
          timeLimitMs: wallLimitMs > 0 ? wallLimitMs : undefined,
        });
        await appendUsageLog({
          at: Date.now(),
          session_id: sessionId,
          mode,
          model: providerRef?.model,
          turn,
          prompt_estimate: requestEstimate,
          prompt_tokens: lastUsage?.prompt_tokens,
          completion_tokens: lastUsage?.completion_tokens,
          total_tokens: lastUsage?.total_tokens,
          context_window: contextWindow,
          input_budget: inputBudget,
          compacted: compactedThisTurn,
          pruned_tokens: prunedTokensThisTurn,
          provider_reported: Boolean(lastUsage),
          steps: metricsSnapshot.steps,
          step_limit: metricsSnapshot.step_limit,
          tool_calls: metricsSnapshot.tool_calls,
          tool_counts: metricsSnapshot.tool_counts,
          repeated_calls: metricsSnapshot.repeated_calls,
          duration_ms: metricsSnapshot.duration_ms,
          finish_reason: finishReason,
        });
      }

      // An interrupted turn stops here. Never promote buffered reasoning into an
      // answer, and never run recovery that would call the provider again.
      if (signal?.aborted) {
        sink(usageEvent(totals, true));
        sink({ type: "done", finish_reason: "aborted" });
        return {
          message: makeMessage(`${runId}-turn-${turn}`, "assistant", ""),
          usage: totals,
          finish_reason: "aborted",
        };
      }

      if (timeStalled || reasoningStalled) {
        const reasonText = timeStalled
          ? `The provider sent no output for ${this.maxSilentReasoningSeconds} seconds.`
          : `The model reasoned for about ${Math.max(1, Math.round(this.maxSilentReasoningChars / 4))} tokens without answering or calling a tool.`;
        // A long reasoning pass usually still knows the next action. Ask for
        // that action once, with thinking turned down, before giving up.
        const canRecover =
          reasoningRecoveries < 1 &&
          !accumulator.hasTextOutput() &&
          !accumulator.hasToolCalls() &&
          !turnError;
        if (canRecover) {
          reasoningRecoveries += 1;
          forceAction = true;
          messages.push(
            makeMessage(
              `${runId}-reason-${turn}-act`,
              "user",
              [
                "You reached the reasoning limit for this step.",
                "Stop reasoning and act now: call the next tool or write the final answer from the results you already have.",
                "Do not restate the plan and do not repeat research.",
              ].join(" "),
            ),
          );
          sink({
            type: "advisor_note",
            note: `${reasonText} Asking the model to act now.`,
            severity: "info",
          });
          finishReason = "stop";
          turnError = undefined;
          turnErrorCode = undefined;
          continue;
        }
        sink({
          type: "error",
          code: "reasoning_stall",
          message: [
            reasonText,
            "Turn stopped. Retry, lower the thinking effort, or raise reasoning.max_silent_chars.",
          ].join(" "),
          recoverable: true,
        });
        sink(usageEvent(totals, true));
        sink({ type: "done", finish_reason: "error" });
        return {
          message: makeMessage(`${runId}-turn-${turn}`, "assistant", ""),
          usage: totals,
          finish_reason: "error",
        };
      }

      if (turnError && !contextOverflow && !errorSunk && turnRetries < MAX_TURN_RETRIES) {
        turnRetries += 1;
        const delayMs = 500 * turnRetries;
        sink({
          type: "retry_scheduled",
          attempt: turnRetries,
          max_attempts: MAX_TURN_RETRIES,
          delay_ms: delayMs,
          reason: turnError.slice(0, 200),
        });
        try {
          await sleepAbortable(delayMs, signal);
        } catch {
          sink({ type: "done", finish_reason: "aborted" });
          return {
            message: makeMessage(`turn-${turn}`, "assistant", ""),
            usage: totals,
            finish_reason: "aborted",
          };
        }
        turnError = undefined;
        turnErrorCode = undefined;
        finishReason = "stop";
        continue;
      }

      if (turnError && isOutputBudgetError(turnError) && !outputBudgetRetried) {
        const next = reduceOutputTokensFromError(
          turnError,
          maxTokens,
          estimatePromptTokens(),
          contextWindow,
        );
        if (next !== undefined) {
          outputBudgetRetried = true;
          forcedOutputLimit = next;
          maxTokens = next;
          turnError = undefined;
          turnErrorCode = undefined;
          contextOverflow = false;
          continue;
        }
      }

      if (contextOverflow && overflowAttempts < OVERFLOW_SHRINK_STEPS.length) {
        overflowAttempts += 1;
        contextWindow = refreshContextWindow();
        const keepTokens = keepTokensForAttempt();
        sink({
          type: "compaction_start",
          reason: "retry",
          attempt: overflowAttempts,
          max_attempts: OVERFLOW_SHRINK_STEPS.length,
        });
        try {
          const forced = await compactMessages(messages, {
            provider,
            contextWindow,
            keepTokens,
            buffer: this.compactionConfig.buffer,
            reserveTokens: this.compactionConfig.reserve_tokens,
            bufferTokens: this.compactionConfig.buffer_tokens,
            bufferRatio: this.compactionConfig.buffer_ratio,
            overheadTokens,
            contextTokens: measuredPromptTokens(),
            previousSummary: extractSummary(messages),
            precomputed: this.precomputedCompactions.get(precomputeKey),
            force: true,
          });
          if (forced.didCompact) {
            this.precomputedCompactions.delete(precomputeKey);
            precomputeEpoch += 1;
            messages = forced.messages;
            this.appendSkillReload(sessionId, messages, Date.now());
            ensureDynamicMessages();
            measuredContext = undefined;
            maxTokens =
              forcedOutputLimit ??
              Math.max(1024, Math.min(requestedMaxTokens, outputCap, outputHeadroom()));
            sink({
              type: "compaction",
              reason: "retry",
              trigger: "overflow",
              before_tokens: forced.beforeTokens,
              after_tokens: forced.afterTokens,
              summary_tokens: forced.summaryTokens,
              summary: forced.summary,
              removed_messages: forced.removedMessages,
              tail_start_message_id: forced.tailStartMessageId,
              request_bytes: estimateRequestBytes({ system, messages, tools: turnTools }),
              max_request_bytes: this.maxRequestBytes,
              input_budget: inputBudget,
              buffer_tokens: bufferTokens,
              attempt: overflowAttempts,
              max_attempts: OVERFLOW_SHRINK_STEPS.length,
            });
            turnError = undefined;
            turnErrorCode = undefined;
            contextOverflow = false;
            continue;
          }
        } catch (error) {
          compactionFailure = error instanceof Error ? error.message : String(error);
          turnError = `request too large and compaction failed: ${compactionFailure}`;
          turnErrorCode = "compaction_failed";
          const tokens = measuredPromptTokens() ?? estimatePromptTokens();
          sink({
            type: "compaction",
            reason: "retry",
            trigger: "overflow",
            before_tokens: tokens,
            after_tokens: tokens,
            summary_tokens: 0,
            removed_messages: 0,
            request_bytes: estimateRequestBytes({ system, messages, tools: turnTools }),
            max_request_bytes: this.maxRequestBytes,
            input_budget: inputBudget,
            buffer_tokens: bufferTokens,
            attempt: overflowAttempts,
            max_attempts: OVERFLOW_SHRINK_STEPS.length,
            status: "error",
            error: compactionFailure,
          });
        }

        // If the summary did not remove anything, fall back to a transcript
        // reduction level. Levels 1-2 keep call/result pairing; levels 3-4
        // become text-only so a single oversized turn cannot keep the request
        // above the provider's body limit forever.
        const beforeBytes = estimateRequestBytes({ system, messages, tools: turnTools });
        const reduced = reduceTranscriptForOverflow(messages, overflowAttempts);
        const afterBytes = estimateRequestBytes({ system, messages: reduced, tools: turnTools });
        if (afterBytes < beforeBytes) {
          const beforeTokens = estimatePromptTokens();
          const removedMessages = messages.length - reduced.length;
          messages = reduced;
          ensureDynamicMessages();
          measuredContext = undefined;
          maxTokens =
            forcedOutputLimit ??
            Math.max(1024, Math.min(requestedMaxTokens, outputCap, outputHeadroom()));
          sink({
            type: "compaction",
            reason: "retry",
            trigger: "overflow",
            before_tokens: beforeTokens,
            after_tokens: estimatePromptTokens(),
            summary_tokens: 0,
            removed_messages: removedMessages,
            request_bytes: afterBytes,
            max_request_bytes: this.maxRequestBytes,
            input_budget: inputBudget,
            buffer_tokens: bufferTokens,
            attempt: overflowAttempts,
            max_attempts: OVERFLOW_SHRINK_STEPS.length,
            status: "done",
          });
          turnError = undefined;
          turnErrorCode = undefined;
          contextOverflow = false;
          continue;
        }
      }

      // A model that prints a tool call as JSON text never reaches the tool
      // channel. Recover it so the work still runs, then drop the JSON text.
      if (!turnError && finishReason === "stop" && accumulator.hasTextOutput()) {
        const recovered = parseTextToolCall(
          accumulator.textOutput(),
          turnTools.map((tool) => tool.name),
        );
        if (recovered) {
          accumulator.discardText();
          accumulator.finishTool({
            type: "tool_call_ready",
            id: recovered.id,
            name: recovered.name,
            arguments: recovered.arguments,
          });
          // The JSON was already streamed; clear it so the client shows the
          // tool rows and the real answer instead of the raw call text.
          sink({ type: "final_text", text: "" });
          finishReason = "tool_calls";
        }
      }

      const assistantMessage = accumulator.toMessage(`${runId}-turn-${turn}`);
      let toolUses = assistantMessage.content.filter((block) => block.type === "tool_use");
      if (finalStep && toolUses.length > 0) {
        // The final step never runs tools. Keep any text the model produced and
        // add a clear fallback when it produced only tool calls.
        assistantMessage.content = assistantMessage.content.filter(
          (block) => block.type !== "tool_use",
        );
        if (
          !assistantMessage.content.some(
            (block) => block.type === "text" && block.text.trim().length > 0,
          )
        ) {
          assistantMessage.content.push({ type: "text", text: FINAL_STEP_FALLBACK });
          sink({ type: "final_text", text: FINAL_STEP_FALLBACK });
        }
        toolUses = [];
        finishReason = "stop";
      }
      messages.push(assistantMessage);
      persistConversationMessage(assistantMessage);

      if (toolUses.length === 0 || turnError) {
        if (!turnError && contract.enforceTodos && !finalStep) {
          const enforcement = this.todos.checkPendingTodos();
          if (enforcement.hasPending) {
            messages.push(makeMessage(`turn-${turn}-todo`, "user", enforcement.continuationPrompt));
            continue;
          }
        }
        if (!turnError && finishReason === "stop" && ultraworkNudges < contract.nudges && !finalStep) {
          ultraworkNudges += 1;
          const nudge = [
            "You are not finished yet.",
            "Verify the result with tools, finish any remaining work, and update the todo list.",
            "If everything is complete, reply with a short final summary.",
          ].join(" ");
          messages.push(makeMessage(`turn-${turn}-continue`, "user", nudge));
          continue;
        }
        if (!turnError && finishReason === "length" && outputLimitContinues < MAX_OUTPUT_LIMIT_CONTINUES && !finalStep) {
          outputLimitContinues += 1;
          if (!outputLimitCompacted) {
            outputLimitCompacted = true;
            const hasPriorTurn =
              messages.filter(
                (message) => message.role === "user" && !isSyntheticMessage(message),
              ).length > 1;
            const compacted = hasPriorTurn
              ? await compactMessages(messages, {
                  provider,
                  contextWindow,
                  keepTokens: this.compactionConfig.keep_tokens,
                  buffer: this.compactionConfig.buffer,
                  reserveTokens: this.compactionConfig.reserve_tokens,
                  bufferTokens: this.compactionConfig.buffer_tokens,
                  bufferRatio: this.compactionConfig.buffer_ratio,
                  overheadTokens,
                  contextTokens: measuredPromptTokens(),
                  previousSummary: extractSummary(messages),
                  precomputed: this.precomputedCompactions.get(precomputeKey),
                  force: true,
                  onStart: () => sink({ type: "compaction_start", reason: "output_limit" }),
                })
              : undefined;
            if (compacted?.didCompact) {
              this.precomputedCompactions.delete(precomputeKey);
              precomputeEpoch += 1;
              messages = compacted.messages;
              this.appendSkillReload(sessionId, messages, Date.now());
              ensureDynamicMessages();
              measuredContext = undefined;
              maxTokens =
                forcedOutputLimit ??
                Math.max(1024, Math.min(requestedMaxTokens, outputCap, outputHeadroom()));
              sink({
                type: "compaction",
                reason: "output_limit",
                trigger: "output_limit",
                before_tokens: compacted.beforeTokens,
                after_tokens: compacted.afterTokens,
                summary_tokens: compacted.summaryTokens,
                summary: compacted.summary,
                removed_messages: compacted.removedMessages,
                tail_start_message_id: persistableTail(compacted.tailStartMessageId),
                request_bytes: estimateRequestBytes({ system, messages, tools: turnTools }),
                max_request_bytes: this.maxRequestBytes,
                input_budget: inputBudget,
                buffer_tokens: bufferTokens,
              });
            }
          }
          messages.push(
            makeMessage(
              `turn-${turn}-output-limit`,
              "user",
              CONTINUE_AFTER_OUTPUT_LIMIT,
            ),
          );
          continue;
        }

        const textOf = (message: Message): string =>
          message.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n")
            .trim();
        let finalMessage = assistantMessage;
        if (!turnError) {
          const rawText = textOf(finalMessage);
          const hasHardDump = /<skill_content\b|<skill_files\b|<available_skills\b|<file\b/i.test(
            rawText,
          );
          const shouldRetryDump = hasHardDump || looksLikeInternalDump(rawText);
          const cleaned = shouldRetryDump
            ? await retryAfterInternalDump(rawText)
            : sanitizeAssistantText(rawText);
          // A thinking model sometimes returns the whole answer in its reasoning
          // stream. Accept that only for a short block that reads like an answer.
          const reasoningAnswer = accumulator.reasoningOutput().trim();
          const reasoningIsAnswer =
            cleaned.length === 0 &&
            reasoningAnswer.length > 0 &&
            reasoningAnswer.length <= MAX_REASONING_ANSWER_CHARS &&
            toolUses.length === 0 &&
            finishReason === "stop" &&
            !looksLikeInternalDump(reasoningAnswer);
          let finalText =
            cleaned.length > 0
              ? cleaned
              : reasoningIsAnswer
                ? sanitizeAssistantText(reasoningAnswer)
                : REASONING_ONLY_MESSAGE;
          if (cleaned.length === 0 && !reasoningIsAnswer) finishReason = "error";
          if (
            request.task === "study" &&
            !studyRetried &&
            (cleaned.length === 0 || finalText.trim().length < MIN_STUDY_ANSWER_CHARS)
          ) {
            studyRetried = true;
            const retried = await retryWithCorrection(rawText, [
              "The previous answer was empty or too short.",
              "Write the project report now using the project evidence and tool results already present.",
              "Start with what the project is. Include main modules, architecture, and how to run and test it.",
              "Do not write code or a plan. Reply in the user's language.",
            ]);
            if (retried.trim().length > 0) {
              finalText = retried;
              finishReason = "stop";
            }
          }
          if (finalText !== rawText) {
            finalMessage = makeMessage(assistantMessage.id, "assistant", finalText);
            sink({ type: "final_text", text: finalText });
          }
        }
        if (turnError && !errorSunk) {
          const overflowFailure = contextOverflow && overflowAttempts > 0;
          sink({
            type: "error",
            code: overflowFailure ? "context_overflow" : "provider_adjusted",
            message: overflowFailure
              ? compactionFailure
                ? [
                    `Request too large; compaction failed after ${overflowAttempts} shrink attempt(s): ${compactionFailure}`,
                    "Run /compact to summarize this session, or /new to start fresh.",
                  ].join(" ")
                : [
                    `Provider rejected the request as too large after ${overflowAttempts} shrink attempt(s).`,
                    "Run /compact to summarize this session, or /new to start fresh.",
                  ].join(" ")
              : isAutoHandledProviderError(turnError, turnErrorCode)
                ? "provider request failed after automatic adjustment"
                : turnError,
            recoverable: false,
          });
        }
        await this.hooks.runOnStop({});
        const finalReason: FinishReason = turnError
          ? "error"
          : finalStep && finishReason !== "error"
            ? "turn_limit"
            : finishReason;
        sink(usageEvent(totals, true));
        sink({ type: "done", finish_reason: finalReason });
        return { message: finalMessage, usage: totals, finish_reason: finalReason };
      }

      // Read-only batches announce every start first, so the transcript keeps
      // the order the model asked for even when tools finish out of order.
      const startTool = (block: ToolUseBlock): number => {
        const startedAt = Date.now();
        const call: ToolCall = { id: block.id, name: block.name, arguments: block.input };
        const filePath = extractFilePath(call.arguments);
        const display = toolDisplay(call.name, call.arguments);
        sink({
          type: "tool_start",
          id: call.id,
          name: call.name,
          label: display.label,
          detail: display.detail,
          command: typeof call.arguments.command === "string" ? call.arguments.command : undefined,
          arguments_summary: summarizeArguments(call.arguments),
          file_path: filePath,
        });
        return startedAt;
      };

      const runTool = async (
        block: ToolUseBlock,
        toolStartedAt: number,
      ): Promise<{ message: Message; skillDocument?: SkillDocument }> => {
        const call: ToolCall = { id: block.id, name: block.name, arguments: block.input };
        const filePath = extractFilePath(call.arguments);
        const readOffset =
          call.name === "read_file" && typeof call.arguments.offset === "number"
            ? call.arguments.offset
            : 1;
        const readLimit =
          call.name === "read_file" && typeof call.arguments.limit === "number"
            ? call.arguments.limit
            : 2000;
        const readPath =
          call.name === "read_file" && typeof call.arguments.filePath === "string"
            ? call.arguments.filePath
            : undefined;

        const signature = toolCallSignature(call.name, call.arguments, this.root);
        const readUnchanged = readPath
          ? await readFileCache.unchanged(readPath, readOffset, readLimit, this.root)
          : false;
        if (readPath && !readUnchanged) {
          // A changed file makes this a fresh read, not a repeat.
          toolCallTracker.resetSignature(signature);
        }
        const callState = toolCallTracker.record(signature, call.name, call.id);
        if (callState.repeated) {
          metrics.recordRepeatedCall();
          const readOnly = this.registry.get(call.name)?.readOnly === true;
          const message = toolResultMessage(
            call,
            readOnly
              ? `The same ${call.name} call was already made ${callState.count} times in this turn. This call was not run. Use the earlier result${callState.previousCallId ? ` from ${callState.previousCallId}` : ""}, or change the request.`
              : `The same mutating ${call.name} call was already made ${callState.count} times in this turn. This call was not run. Change the approach or ask the user before repeating it.`,
            true,
            runId,
          );
          sink({
            type: "tool_end",
            id: call.id,
            name: call.name,
            status: "error",
            duration_ms: Date.now() - toolStartedAt,
            file_path: filePath,
            output: readOnly
              ? "repeated read-only call suppressed"
              : "repeated mutating call suppressed",
          });
          return { message };
        }

        if (readUnchanged) {
          const message = toolResultMessage(
            call,
            "File unchanged since the last read in this turn; use the previous content or request a different range.",
            false,
            runId,
          );
          sink({
            type: "tool_end",
            id: call.id,
            name: call.name,
            status: "ok",
            duration_ms: Date.now() - toolStartedAt,
            file_path: filePath,
            output: "unchanged since the last read",
          });
          return { message };
        }

        if (call.name === "web_search" && webSearchLimit > 0 && webSearchCalls >= webSearchLimit) {
          const message = toolResultMessage(
            call,
            `Web search budget reached (${webSearchLimit} searches in this turn). This search was not run.`,
            true,
            runId,
          );
          sink({
            type: "tool_end",
            id: call.id,
            name: call.name,
            status: "error",
            duration_ms: Date.now() - toolStartedAt,
            file_path: filePath,
            output: "web search budget reached",
          });
          return { message };
        }
        if (call.name === "web_search") webSearchCalls += 1;

        if (!skillPolicy.allows(call.name)) {
          const blocked = toolResultMessage(call, `blocked: the active skill does not allow the ${call.name} tool`, true, runId);
          sink({
            type: "tool_end",
            id: call.id,
            name: call.name,
            status: "error",
            duration_ms: Date.now() - toolStartedAt,
            file_path: filePath,
            output: "blocked: the active skill does not allow this tool",
          });
          return { message: blocked };
        }

        const pre = await this.hooks.runPreToolUse({ toolName: call.name, args: call.arguments, filePath });
        if (pre.allowed === false) {
          const blocked = toolResultMessage(call, `blocked: ${pre.reason ?? "pre tool use hook"}`, true, runId);
          sink({
            type: "tool_end",
            id: call.id,
            name: call.name,
            status: "error",
            duration_ms: Date.now() - toolStartedAt,
            file_path: filePath,
            output: `blocked: ${pre.reason ?? "pre tool use hook"}`,
          });
          return { message: blocked };
        }

        const mutates = this.registry.get(call.name)?.readOnly === false;
        const captureChange = Boolean(filePath && mutates && mode !== "plan");
        const beforeText = captureChange && filePath ? (await readTextFile(filePath)) ?? "" : undefined;
        const hashEditOwnsSnapshot =
          call.name === "hash_edit" && this.hashEditLifecycle?.onBeforeModify !== undefined;
        if (filePath && mutates && mode !== "plan" && !hashEditOwnsSnapshot) {
          const rulesText = await this.rules.getRulesForFile(filePath);
          if (rulesText) messages.push(makeMessage(`turn-${turn}-rules`, "system", rulesText));
          try {
            await this.snapshots.captureSnapshot(`before ${call.name} ${filePath}`);
          } catch (error) {
            sink({
              type: "thinking_token",
              text: `[snapshot] failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }

        const agentRules = activeSpecialist?.permissions?.length
          ? permissionRulesFromConfig(activeSpecialist.permissions)
          : [];
        const result = await this.registry.run(call, mode, signal, agentRules);
        if (call.name === "read_file" && readPath && !result.is_error) {
          await readFileCache.remember(readPath, readOffset, readLimit, this.root);
        }
        let content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
        let skillDocument: SkillDocument | undefined;
        if (call.name === "skill" && !result.is_error) {
          const skillName =
            typeof call.arguments.id === "string"
              ? call.arguments.id
              : typeof call.arguments.name === "string"
                ? call.arguments.name
                : undefined;
          const document = skillName ? this.skills.get(skillName) : undefined;
          if (document && !activatedSkills.has(document.name)) {
            skillDocument = document;
            activatedSkills.add(document.name);
            if (document.allowedTools !== undefined) skillPolicy.activate(document.allowedTools);
            if (
              !activeSkillDocs.some((entry) => entry.name === document.name) &&
              !turnSkills.some((entry) => entry.name === document.name)
            ) {
              activeSkillDocs.push(document);
            }
            sink({
              type: "skill_activated",
              name: document.name,
              allowed_tools: document.allowedTools ?? [],
              trigger: "tool",
            });
          }
        }
        sink({
          type: "tool_end",
          id: call.id,
          name: call.name,
          status: result.is_error ? "error" : "ok",
          duration_ms: Date.now() - toolStartedAt,
          file_path: filePath,
          output: toolOutputPreview(call.name, content, result.is_error),
        });

        if (captureChange && filePath && beforeText !== undefined) {
          const afterText = (await readTextFile(filePath)) ?? "";
          if (afterText !== beforeText) {
            const stats = countLineChanges(beforeText, afterText);
            sink({
              type: "file_change",
              path: filePath,
              old_text: beforeText.slice(0, MAX_DIFF_CHARS),
              new_text: afterText.slice(0, MAX_DIFF_CHARS),
              additions: stats.additions,
              deletions: stats.deletions,
              tool_call_id: call.id,
            });
          }
        }

        if (call.name === "move_file" && mode !== "plan" && typeof call.arguments.destinationPath === "string") {
          const destination = call.arguments.destinationPath;
          const destinationText = (await readTextFile(destination)) ?? "";
          if (destinationText.length > 0) {
            const stats = countLineChanges("", destinationText);
            sink({
              type: "file_change",
              path: destination,
              old_text: "",
              new_text: destinationText.slice(0, MAX_DIFF_CHARS),
              additions: stats.additions,
              deletions: 0,
              tool_call_id: call.id,
            });
          }
        }

        const post = await this.hooks.runPostToolUse({
          toolName: call.name,
          args: call.arguments,
          filePath,
          resultContent: content,
          isError: result.is_error,
        });
        if (post.notes?.length) content = `${content}\n${post.notes.join("\n")}`;

        if (filePath) {
          const diagnostics = this.pendingDiagnostics.get(filePath);
          if (diagnostics) {
            this.pendingDiagnostics.delete(filePath);
            content = `${content}\n${diagnostics}`;
          }
        }

        const toolResult = toolResultMessage(call, content, result.is_error, runId);
        if (filePath && mutates && contract.advisor) this.advisor.scheduleReview();
        return { message: toolResult, skillDocument };
      };

      const concurrencyEnabled =
        toolUses.length > 1 &&
        capabilities.tool_calling &&
        capabilities.parallel_tool_calls &&
        !this.prefersSequentialTools(providerRef?.provider, providerRef?.model);
      const isConcurrentSafe = (name: string): boolean =>
        isConcurrentSafeTool(name) && this.registry.get(name)?.readOnly === true;
      const batches = concurrencyEnabled
        ? partitionToolBatches(toolUses, isConcurrentSafe)
        : toolUses.map((block): ToolBatch => ({ mode: "sequential", calls: [block] }));

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const batch = batches[batchIndex];
        const remaining = toolLimit > 0 ? toolLimit - metrics.toolCallCount : Number.POSITIVE_INFINITY;
        if (remaining <= 0 || (Number.isFinite(remaining) && batch.calls.length > remaining)) {
          toolBudgetExhausted = true;
          sink({
            type: "turn_budget_warning",
            reason: "tool",
            used: metrics.toolCallCount,
            limit: toolLimit,
          });
          for (const block of batches.slice(batchIndex).flatMap((entry) => entry.calls)) {
            const call: ToolCall = { id: block.id, name: block.name, arguments: block.input };
            const message = toolResultMessage(
              call,
              `Tool budget reached (${toolLimit} calls in this turn). This tool was not run.`,
              true,
              runId,
            );
            messages.push(message);
            persistConversationMessage(message);
          }
          break;
        }
        if (batch.mode === "parallel") {
          const started = batch.calls.map((block) => ({ block, at: startTool(block) }));
          const outcomes: Array<{ message: Message; skillDocument?: SkillDocument }> = new Array(
            started.length,
          );
          await runWithConcurrency(started, MAX_CONCURRENT_TOOLS, async (entry, index) => {
            outcomes[index] = await runTool(entry.block, entry.at);
          });
          for (const outcome of outcomes) {
            messages.push(outcome.message);
            persistConversationMessage(outcome.message);
            if (outcome.skillDocument) {
              this.activateSkill(sessionId, outcome.skillDocument.name);
            }
          }
          continue;
        }
        const outcome = await runTool(batch.calls[0], startTool(batch.calls[0]));
        messages.push(outcome.message);
        persistConversationMessage(outcome.message);
        if (outcome.skillDocument) {
          this.activateSkill(sessionId, outcome.skillDocument.name);
        }
      }

      if (toolBudgetExhausted) {
        if (stepLimit === 0 || turn + 1 < stepLimit) {
          continue;
        }
        const notice = `Tool budget reached (${toolLimit} calls in this turn). Send another message to continue, or raise limits.max_tool_calls.`;
        sink({ type: "final_text", text: notice });
        sink(usageEvent(totals, true));
        sink({ type: "done", finish_reason: "turn_limit" });
        return {
          message: makeMessage(`${runId}-tool-budget`, "assistant", notice),
          usage: totals,
          finish_reason: "turn_limit",
        };
      }

      const switchedMode = this.consumeModeSwitch();
      if (switchedMode) applyModeSwitch(switchedMode, turn);

      if (request.task && toolUses.length > 0 && !taskNudged) {
        taskNudged = true;
        messages.push(
          makeMessage(
            `turn-${turn}-task`,
            "user",
            request.task === "study" ? STUDY_NUDGE : REVIEW_NUDGE,
          ),
        );
      }
    }

    const notice = `Stopped after reaching the ${stepLimit} step limit for ${mode.toUpperCase()} mode with work still in progress. Send another message to continue, or raise modes.${mode}.steps.`;
    sink({ type: "final_text", text: notice });
    sink(usageEvent(totals, true));
    sink({ type: "done", finish_reason: "turn_limit" });
    return {
      message: makeMessage("turn-exhausted", "assistant", notice),
      usage: totals,
      finish_reason: "turn_limit",
    };
  }

  private activeSkillNames(sessionId: string | undefined): string[] {
    const names = new Set(this.ephemeralSkills);
    if (sessionId) {
      try {
        for (const skill of this.database.listSessionSkills(sessionId)) names.add(skill.name);
      } catch {
        // Fall back to the in-memory set if the session is unavailable.
      }
    }
    return [...names];
  }

  private activeSkillDocuments(sessionId: string | undefined): SkillDocument[] {
    return this.activeSkillNames(sessionId)
      .map((name) => this.skills.get(name))
      .filter((document): document is SkillDocument => Boolean(document));
  }

  private appendSkillReload(
    sessionId: string | undefined,
    messages: Message[],
    marker: number,
  ): void {
    if (!sessionId) return;
    const documents = this.activeSkillDocuments(sessionId);
    if (documents.length === 0) return;
    if (marker <= (this.lastSkillReload.get(sessionId) ?? 0)) return;
    messages.push(
      makeMessage(`skill-reload-${sessionId}-${marker}`, "system", formatSkillReload(documents)),
    );
    this.lastSkillReload.set(sessionId, marker);
  }

  private async reloadSkillsAfterCompaction(
    sessionId: string | undefined,
    messages: Message[],
  ): Promise<void> {
    if (!sessionId) return;
    const compaction = this.database.getCompaction(sessionId);
    if (!compaction) return;
    this.appendSkillReload(sessionId, messages, compaction.created_at);
  }

  private activateSkill(sessionId: string | undefined, name: string): boolean {
    const document = this.skills.get(name);
    if (!document) return false;
    const alreadyActive = this.activeSkillNames(sessionId).includes(document.name);
    if (sessionId) {
      try {
        this.database.activateSessionSkill(sessionId, document.name);
      } catch {
        this.ephemeralSkills.add(document.name);
      }
    } else {
      this.ephemeralSkills.add(document.name);
    }
    return !alreadyActive;
  }

  private rememberPrompt(sessionId: string | undefined, snapshot: PromptSnapshot): void {
    if (!sessionId) return;
    this.lastPrompts.set(sessionId, snapshot);
    if (this.lastPrompts.size > 32) {
      const oldest = this.lastPrompts.keys().next().value;
      if (oldest) this.lastPrompts.delete(oldest);
    }
  }

  /**
   * The compact prompt is an explicit opt-in. Provider kind never changes the
   * instructions, so every model gets the same guidance in every mode.
   */
  private useCompactPrompt(): boolean {
    return this.promptStyle === "compact";
  }

  private readOnlyToolNames(): ReadonlySet<string> {
    return new Set(
      this.registry
        .list()
        .filter((tool) => tool.readOnly)
        .map((tool) => tool.name),
    );
  }

  private spawnTaskWorker(input: TaskSpawnInput): { workerId: string; done: Promise<TaskWorkerOutcome> } {
    let resolveDone!: (outcome: TaskWorkerOutcome) => void;
    const done = new Promise<TaskWorkerOutcome>((resolve) => {
      resolveDone = resolve;
    });

    const worker = this.subagents.spawnOne({
      task: input.task,
      agent: input.agent,
      mode: input.mode,
      roleModel: input.roleModel,
      provider: input.provider,
      model: input.model,
      writeIsolation: input.writeIsolation,
      onComplete: (finished) => {
        void this.captureWorkerOutcome(finished).then(resolveDone);
      },
    });

    return { workerId: worker.id, done };
  }

  private async captureWorkerOutcome(worker: SubagentWorkerState): Promise<TaskWorkerOutcome> {
    const output = worker.result?.output;
    const error = worker.result?.error?.message ?? worker.error?.message;
    let diff: string | undefined;
    let filesChanged: string[] = [];

    if (worker.worktreePath) {
      try {
        const status = await runGit(worker.worktreePath, ["status", "--porcelain"], { allowFailure: true });
        filesChanged = status.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 3)
          .map((line) => line.slice(3).trim());

        const staged = await runGit(worker.worktreePath, ["diff", "--cached", "--", "."], { allowFailure: true });
        const unstaged = await runGit(worker.worktreePath, ["diff", "--", "."], { allowFailure: true });
        const combined = `${staged.stdout}${unstaged.stdout}`.trim();
        if (combined.length > 0) diff = combined.slice(0, 20_000);
      } catch {
        // Worker diff capture is best effort and never fails the task.
      }
    }

    return { output, error, diff, filesChanged };
  }

  private async executeSubagent(input: SubagentTaskInput): Promise<SubagentTaskResult> {
    let specialist: SpecialistAgentProfile | undefined;
    if (input.agent) {
      specialist = await this.specialistAgents.getAgent(input.agent);
    }
    if (!specialist) {
      const mention = await this.specialistAgents.parseMention(input.task);
      if (mention?.profile) {
        specialist = mention.profile;
      }
    }

    const requestedRole = input.roleModel ?? specialist?.roleModel;
    const role: "main" | "fast" | "advisor" | undefined =
      requestedRole === "advisor" || requestedRole === "fast" || requestedRole === "main"
        ? requestedRole
        : undefined;
    const mode = input.mode ?? "build";
    const providerName =
      input.provider ??
      (role ? this.router.getRole(role)?.provider : this.router.getModeModel(mode)?.provider);
    const provider =
      input.provider && input.model
        ? this.router.provider(input.provider, input.model)
        : role
          ? this.router.get(role)
          : this.router.getMode(mode);
    const capabilities =
      input.provider && input.model
        ? this.router.capabilitiesFor(input.provider, input.model)
        : role
          ? this.router.capabilitiesForRole(role)
          : this.router.capabilitiesForMode(mode);
    const messages: Message[] = [];
    const scope = input.worktreePath
      ? `Work only inside this directory: ${input.worktreePath}\n\n`
      : "";
    messages.push(makeMessage("subagent-task", "user", `${scope}${input.task}`));
    const totals = zeroUsage();

    const effectiveMode = input.mode ?? (specialist?.readOnly ? "plan" : "build");
    let tools = this.filterToolsForCapabilities(
      filterToolsForMode(this.registry.listDefinitions(), effectiveMode),
      capabilities,
    ).filter((tool) => !SUBAGENT_BLOCKED_TOOLS.has(tool.name));
    if (!capabilities.tool_calling) tools = [];
    if (specialist) {
      tools = this.specialistAgents.filterTools(specialist, tools, this.readOnlyToolNames());
    }
    const outputCap = Math.min(capabilities.max_output ?? 32_000, 256_000);
    const requestedMaxTokens = specialist?.thinkingBudget
      ? Math.max(outputCap, specialist.thinkingBudget)
      : outputCap;
    const subagentMaxTokens = Math.max(1024, Math.min(requestedMaxTokens, outputCap));
    const compactPrompt = this.useCompactPrompt();
    const subagentSystemParts = buildSystemParts({
      mode: effectiveMode,
      providerKind: providerName ? this.router.providerKind(providerName) : undefined,
      model:
        input.model ??
        (role ? this.router.getRole(role)?.model : this.router.getModeModel(mode)?.model),
      modelName:
        input.model ??
        (role ? this.router.getRole(role)?.model : this.router.getModeModel(mode)?.model),
      repoRoot: input.worktreePath ?? this.root,
      branch: this.branch,
      agentInstructions: this.globalRules,
      specialistPrompt: specialist?.systemPrompt,
      projectSummary: this.projectContext?.summary,
      skillsIndex: this.skills.buildIndexPrompt({ compact: compactPrompt }),
      compact: compactPrompt,
      includeClosing: false,
      tools: tools.map((tool) => tool.name),
    });
    const subagentSystem = subagentSystemParts.map((part) => part.text).join("\n\n");
    for (let turn = 0; turn < MAX_SUBAGENT_TURNS; turn += 1) {
      for (const instruction of input.drainSteerings()) {
        messages.push(makeMessage(`subagent-steer-${turn}`, "user", `Steering instruction: ${instruction}`));
        input.onTranscript(`steering: ${instruction}`);
      }

      const accumulator = new TurnAccumulator();
      const chatRequest = ChatRequestSchema.parse({
        system: subagentSystem,
        system_parts: subagentSystemParts,
        messages,
        tools,
        tool_choice: tools.length > 0 ? "auto" : "none",
        max_tokens: subagentMaxTokens,
        reasoning_effort: capabilities.reasoning ? "medium" : undefined,
      });
      for await (const event of provider.streamChat(chatRequest, input.signal)) {
        if (event.type === "token") {
          accumulator.addText(event.text);
          input.onTranscript(event.text);
        } else if (event.type === "thinking_token") {
          accumulator.addThinking(event.text, event.signature);
        } else if (event.type === "tool_call_delta") {
          accumulator.addDelta(event);
        } else if (event.type === "tool_call_ready") {
          accumulator.finishTool(event);
        } else if (event.type === "usage") {
          accumulateUsage(totals, event);
          input.onUsage(event);
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }

      const assistantMessage = accumulator.toMessage(`subagent-turn-${turn}`);
      messages.push(assistantMessage);
      const toolUses = assistantMessage.content.filter((block) => block.type === "tool_use");
      if (toolUses.length === 0) {
        return this.finishSubagent(input, accumulator.textOutput(), totals);
      }
      for (const block of toolUses) {
        const call: ToolCall = { id: block.id, name: block.name, arguments: block.input };
        input.onTranscript(`[tool] ${call.name}`);
        const specialistRules = specialist?.permissions?.length
          ? permissionRulesFromConfig(specialist.permissions)
          : [];
        const result = await this.registry.run(call, effectiveMode, input.signal, specialistRules);
        messages.push(
          toolResultMessage(call, typeof result.content === "string" ? result.content : JSON.stringify(result.content), result.is_error),
        );
      }
    }
    return this.finishSubagent(input, `subagent stopped after ${MAX_SUBAGENT_TURNS} turns`, totals);
  }

  /**
   * Adds the worktree diff to a finished subagent so the caller can review or
   * merge it. Without this, isolated work was invisible to the orchestrator.
   */
  private async finishSubagent(
    input: SubagentTaskInput,
    output: string,
    usage: Usage,
  ): Promise<SubagentTaskResult> {
    if (!input.worktreePath) return { output, usage };
    const branch = await runGit(input.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"], {
      allowFailure: true,
    });
    const status = await runGit(input.worktreePath, ["status", "--porcelain"], {
      allowFailure: true,
    });
    const filesChanged = status.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim());
    const staged = await runGit(input.worktreePath, ["diff", "--cached", "--", "."], {
      allowFailure: true,
    });
    const unstaged = await runGit(input.worktreePath, ["diff", "--", "."], {
      allowFailure: true,
    });
    const diff = `${staged.stdout}${unstaged.stdout}`.trim();
    return {
      output,
      usage,
      filesChanged,
      branch: branch.exitCode === 0 ? branch.stdout.trim() || undefined : undefined,
      diff: diff.length > 0 ? diff.slice(0, 20_000) : undefined,
    };
  }

  private filterToolsForCapabilities<T extends { name: string }>(
    tools: T[],
    capabilities?: { edit_mode?: "hashline" | "exact"; patch?: boolean },
  ): T[] {
    return tools.filter((tool) => {
      if (tool.name === "replace_text") return capabilities?.edit_mode === "exact";
      if (tool.name === "hash_edit") return capabilities?.edit_mode !== "exact";
      if (tool.name === "apply_unified_patch") return capabilities?.patch !== false;
      return true;
    });
  }

  private combineTools(
    requestTools: AgentRunRequest["tools"],
    mode: AgentMode,
  ): ReturnType<ToolRegistry["listDefinitions"]> {
    const combined = filterToolsForMode(this.registry.listDefinitions(), mode);
    for (const tool of requestTools) {
      const existing = combined.findIndex((entry) => entry.name === tool.name);
      if (existing >= 0) combined[existing] = tool;
      else combined.push(tool);
    }
    return combined;
  }

  private async collectDiagnostics(filePath: string, newContent: string): Promise<string | undefined> {
    try {
      let diagnostics: LSPDiagnostic[] = [];
      if (this.lsp && this.lsp.isReady()) {
        diagnostics = await this.lsp.notifyFileChanged(filePath, newContent);
      }
      if (diagnostics.length === 0 && (filePath.endsWith(".ts") || filePath.endsWith(".tsx"))) {
        diagnostics = await runTscDiagnostics(this.root, filePath);
      }
      if (diagnostics.length === 0) return "lsp diagnostics: none";
      const selfHealingPrompt = await buildSelfHealingPrompt(filePath, diagnostics, this.root);
      if (selfHealingPrompt) return selfHealingPrompt;
      return [
        `lsp diagnostics (${diagnostics.length}):`,
        ...diagnostics.map((item) => `- ${item.file}:${item.line}:${item.column} ${item.severity}: ${item.message}`),
      ].join("\n");
    } catch (error) {
      return `lsp diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private toAgentTask(worker: SubagentWorkerState, request?: AgentTaskRequest): AgentTask {
    return {
      id: worker.id,
      task: request?.task ?? worker.task,
      profile: request?.profile ?? "orchivox-main",
      webhook_url: request?.webhook_url,
      status: worker.status,
      created_at: worker.createdAt,
      updated_at: worker.updatedAt,
      result: worker.result,
    };
  }

  private async postWebhook(url: string, worker: SubagentWorkerState, request: AgentTaskRequest): Promise<void> {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.toAgentTask(worker, request)),
      });
    } catch {
      // webhook delivery is best effort and never fails the task
    }
  }
}

export function stripThinkTags(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<think(?:ing)?>[\s\S]*$/gi, "")
    .replace(/<\/think(?:ing)?>/gi, "")
    .trim();
}

export function cleanReasoningAnswer(text: string): string {
  return text
    .replace(/\b(?:Let me|I should|I will|I need to)\b[^.!?\n]*[.!?]\s*/gi, "")
    .trim();
}

class TurnAccumulator {
  private text = "";
  private thinking = "";
  private thinkingSignature: string | undefined;
  private readonly drafts = new Map<string, { id: string; name: string; argumentsText: string }>();
  private readonly ready = new Map<string, ToolCallReadyEvent>();

  addText(text: string): void {
    this.text += text;
  }

  addThinking(text: string, signature?: string): void {
    this.thinking += text;
    if (signature) this.thinkingSignature = signature;
  }

  hasOutput(): boolean {
    return this.text.length > 0 || this.thinking.length > 0 || this.drafts.size > 0;
  }

  addDelta(event: ToolCallDeltaEvent): void {
    const draft = this.drafts.get(event.id) ?? { id: event.id, name: "", argumentsText: "" };
    draft.name += event.name_delta;
    draft.argumentsText += event.arguments_delta;
    this.drafts.set(event.id, draft);
  }

  finishTool(event: ToolCallReadyEvent): void {
    this.ready.set(event.id, event);
    this.drafts.set(event.id, { id: event.id, name: event.name, argumentsText: JSON.stringify(event.arguments) });
  }

  textOutput(): string {
    const text = stripThinkTags(this.text);
    if (text.trim().length > 0) return text;
    return cleanReasoningAnswer(stripThinkTags(this.thinking));
  }

  hasTextOutput(): boolean {
    return stripThinkTags(this.text).trim().length > 0;
  }

  hasToolCalls(): boolean {
    return this.drafts.size > 0;
  }

  /** Drops streamed text that turned out to be a tool call in disguise. */
  discardText(): void {
    this.text = "";
  }

  reasoningOutput(): string {
    return cleanReasoningAnswer(stripThinkTags(this.thinking));
  }

  toMessage(id: string): Message {
    const content: Message["content"] = [];
    const text = stripThinkTags(this.text);
    const reasoning = stripThinkTags(this.thinking);
    if (reasoning.length > 0) {
      content.push({
        type: "thinking",
        thinking: reasoning,
        ...(this.thinkingSignature ? { signature: this.thinkingSignature } : {}),
      });
    }
    if (text.length > 0) {
      content.push({ type: "text", text });
    }
    for (const draft of this.drafts.values()) {
      const ready = this.ready.get(draft.id);
      const argumentsObject = ready
        ? ready.arguments
        : parseArguments(draft.argumentsText);
      content.push({ type: "tool_use", id: draft.id, name: ready?.name ?? draft.name, input: argumentsObject });
    }
    return makeMessage(id, "assistant", content);
  }
}

function makeMessage(id: string, role: Message["role"], content: Message["content"] | string): Message {
  return {
    id,
    role,
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
  };
}

function messageText(message: Message): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
}

function lastPlanReminder(
  messages: Message[],
  enter: string,
  leave: string,
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messageText(messages[index]);
    if (text === enter || text === leave) return text;
  }
  return undefined;
}

function insertBeforeLastUser(messages: Message[], additions: Message[]): void {
  if (additions.length === 0) return;
  let index = messages.length;
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (message.role === "user" && !isSyntheticMessage(message)) {
      index = cursor;
      break;
    }
  }
  messages.splice(index, 0, ...additions);
}

function appendSyntheticMessage(messages: Message[], id: string, text: string | undefined): boolean {
  const trimmed = text?.trim();
  if (!trimmed) return false;
  if (messages.some((message) => messageText(message) === trimmed)) return false;
  messages.push({ ...makeMessage(id, "user", trimmed), metadata: { synthetic: true } });
  return true;
}

function toolResultMessage(
  call: ToolCall,
  content: string,
  isError: boolean,
  runId?: string,
): Message {
  return {
    id: runId ? `${runId}-tool-${call.id}` : `tool-${call.id}`,
    role: "tool",
    content: [{ type: "tool_result", tool_use_id: call.id, content, is_error: isError }],
  };
}

function parseArguments(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // malformed fragments fall back to the raw text so nothing is lost
  }
  return { raw: trimmed };
}

function extractFilePath(args: Record<string, unknown>): string | undefined {
  const candidate = args.filePath ?? args.path ?? args.sourcePath;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

export function stripImageBlocks(messages: Message[]): Message[] {
  if (!messages.some((message) => message.content.some((block) => block.type === "image"))) {
    return messages;
  }
  return messages.map((message) => ({
    ...message,
    content: message.content.map((block) =>
      block.type === "image"
        ? {
            type: "text" as const,
            text: `[image attachment: ${block.path ?? "unknown"}; the active model has no vision support. Use inspect_image with imagePath to analyze it.]`,
          }
        : block,
    ),
  }));
}

const MAX_DIFF_CHARS = 24_000;

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text();
  } catch {
    return undefined;
  }
}

function countLineChanges(before: string, after: string): { additions: number; deletions: number } {
  const patch = structuredPatch("before", "after", before, after, undefined, undefined, { context: 0 });
  let additions = 0;
  let deletions = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  return { additions, deletions };
}

const COMMAND_OUTPUT_TOOLS = new Set(["bash", "run_sandbox_script", "execute", "bg_start", "bg_logs"]);
const CONTENT_OUTPUT_TOOLS = new Set([
  "read_file",
  "read_skeleton",
  "diff_view",
  "grep_search",
  "glob_files",
  "json_query",
  "lsp_hover_type",
]);

function toolOutputPreview(name: string, content: string, isError: boolean): string | undefined {
  const command = COMMAND_OUTPUT_TOOLS.has(name);
  const contentPreview = CONTENT_OUTPUT_TOOLS.has(name);
  if (!isError && !command && !contentPreview) return undefined;
  const text = content.replace(/\r\n/g, "\n").trimEnd();
  if (text.length === 0) return undefined;
  const lines = text.split("\n");
  const maxLines = command ? 60 : contentPreview ? 16 : 24;
  const maxChars = command ? 6000 : contentPreview ? 2400 : 3000;
  let preview = lines.slice(0, maxLines).join("\n");
  if (preview.length > maxChars) preview = preview.slice(0, maxChars);
  if (lines.length > maxLines || text.length > maxChars) preview += "\n… output truncated";
  return preview;
}

function summarizeArguments(args: Record<string, unknown>): string {
  const text = JSON.stringify(args);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

export function isContextOverflow(message: string, code?: string): boolean {
  return isContextOverflowError(message, code);
}

function isAutoHandledProviderError(message: string, code?: string): boolean {
  return (
    isOutputBudgetError(message) ||
    isUnsupportedParamsError(message) ||
    isContextOverflowError(message, code)
  );
}

function errorNumber(message: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(message);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function reduceOutputTokensFromError(
  message: string,
  current: number,
  promptTokens: number,
  contextWindow: number,
): number | undefined {
  const contextLimit =
    errorNumber(message, /maximum context length is\s+(\d{3,})/i) ?? contextWindow;
  const prompt =
    errorNumber(message, /prompt contains at least\s+(\d{3,})\s+input tokens/i) ?? promptTokens;
  const requested = errorNumber(message, /requested\s+(\d{3,})\s+output tokens/i);
  const reserve = Math.max(2048, Math.floor(contextLimit * 0.02));
  const available = Math.max(1024, contextLimit - prompt - reserve);
  const fallback = requested !== undefined ? Math.floor(requested / 2) : Math.floor(current / 2);
  const next = Math.max(1024, Math.min(current - 1, available, fallback));
  return next < current ? next : undefined;
}

function effectiveContextWindow(capabilities: {
  context_window?: number;
  max_input?: number;
}): number | undefined {
  const window = capabilities.context_window;
  if (window === undefined) return capabilities.max_input;
  if (capabilities.max_input === undefined) return window;
  return Math.min(capabilities.max_input, window);
}

function clampReasoningEffort(
  requested: string | undefined,
  supported: string[] | undefined,
): string | undefined {
  if (!requested) return undefined;
  if (!supported || supported.length === 0) return requested;
  const normalized = new Map(supported.map((value) => [value.toLowerCase(), value]));
  const direct = normalized.get(requested.toLowerCase());
  if (direct) return direct;
  const order = ["low", "medium", "high"];
  const requestedIndex = order.indexOf(requested.toLowerCase());
  if (requestedIndex === -1) return undefined;
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const fallback = normalized.get(order[index]);
    if (fallback) return fallback;
  }
  for (let index = requestedIndex + 1; index < order.length; index += 1) {
    const fallback = normalized.get(order[index]);
    if (fallback) return fallback;
  }
  return undefined;
}

function zeroUsage(): Usage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

function accumulateUsage(totals: Usage, usage: Usage): void {
  totals.prompt_tokens += usage.prompt_tokens;
  totals.completion_tokens += usage.completion_tokens;
  totals.cache_read_input_tokens += usage.cache_read_input_tokens;
  totals.cache_creation_input_tokens += usage.cache_creation_input_tokens;
  if (usage.cost_usd !== undefined) totals.cost_usd = (totals.cost_usd ?? 0) + usage.cost_usd;
  if (usage.total_tokens !== undefined) {
    totals.total_tokens = (totals.total_tokens ?? 0) + usage.total_tokens;
  }
}

function usageEvent(usage: Usage, turnTotal = false): StreamEvent {
  return { type: "usage", ...usage, ...(turnTotal ? { turn_total: true } : {}) };
}
