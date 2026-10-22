import type {
  AgentRunRequest,
  AgentRunResult,
  AgentTask,
  AgentTaskRequest,
  AgentProfile,
  IAgentRunner,
} from "../api/server";
import type { AppConfig, CompactionConfig, WebFetchConfig, WebSearchConfig } from "../config/loader";
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
  type HashlineLifecycle,
} from "../tools/hashline-edit";
import {
  buildSelfHealingPrompt,
  createDiagnosticsCheckTool,
  runTscDiagnostics,
  type LSPDiagnostic,
} from "../ide/lsp-fixer";
import { ToolRegistry } from "../tools/registry";
import { PersistentShellTool } from "../tools/shell";
import { BackgroundProcessManager } from "../tools/bg-process";
import { createInspectImageTool } from "../tools/vision";
import { registerWebTools } from "../tools/web-reader";
import {
  ChatRequestSchema,
  type AgentMode,
  type FinishReason,
  type Message,
  type StreamEvent,
  type ToolCall,
  type ToolCallDeltaEvent,
  type ToolCallReadyEvent,
  type Usage,
} from "../types/schema";
import type { SnapshotManager } from "../vcs/snapshot";
import type { WorktreeManager } from "../vcs/worktree";
import { AdvisorReviewer } from "./advisor";
import { compactMessages, estimateTextTokens, estimateToolsTokens, extractSummary } from "./compaction";
import { filterToolsForMode } from "./tool-set";
import { CustomCommandEngine } from "./custom-commands";
import { HookRunner, type PluginLoadReport } from "./hooks";
import { GranularPermissionEngine } from "./permissions";
import { SpecialistAgentRegistry, type SpecialistAgentProfile } from "./specialist-agents";
import {
  isCapabilityQuestion,
  isProjectIdentityQuestion,
  isProjectQuestion,
  isProjectStudyRequest,
  loadProjectContext,
  looksLikeNonAnswer,
  type ProjectContext,
} from "./project-context";
import {
  collectProjectEvidence,
  isProjectFileFollowUp,
  looksLikeMissingFileAnswer,
  unknownProjectFiles,
  type ProjectEvidence,
} from "./project-evidence";
import { createQuestionTool, type QuestionHandler } from "../tools/question";
import {
  isDesignQuestion,
  looksLikeInternalDump,
  sanitizeAssistantText,
} from "./output-sanitizer";
import { toolDisplay } from "./tool-display";
import {
  formatActiveSkills,
  formatSkillContent,
  isSkillRelevant,
  matchSkillNames,
  MAX_SKILL_INJECTION_CHARS,
  parseSkillMentions,
  SkillRegistry,
  type SkillDocument,
} from "./skills";
import { SubagentManager, type SubagentTaskInput, type SubagentTaskResult, type SubagentWorkerState } from "./subagent";
import { buildSystemPrompt } from "./system-prompt";
import { TaskBoard, type TaskSpawnInput, type TaskWorkerOutcome } from "./task-board";
import { runWithTurnContext } from "./turn-context";
import { modeContract } from "./modes";
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
const CONTINUE_AFTER_OUTPUT_LIMIT =
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces and continue.";

const PROFILE_MODES: Record<AgentProfile, AgentMode> = {
  "orchivox-main": "build",
  "orchivox-plan": "plan",
  "orchivox-ultrawork": "ultrawork",
};

const MUTATING_TOOL_NAMES = new Set([
  "hash_edit",
  "write_file",
  "create_file",
  "delete_file",
  "move_file",
  "apply_unified_patch",
]);

const VERIFY_TOOL_NAMES = new Set(["diagnostics_check"]);

const VERIFY_COMMAND =
  /\b(?:bun\s+test|bun\s+run\s+(?:typecheck|test|check|lint)|npm\s+(?:test|run)|pnpm\s+(?:test|run)|yarn\s+(?:test|run)|pytest|cargo\s+test|go\s+test|tsc\b|vitest|jest|eslint|biome)\b/i;

const VERIFY_NUDGE = [
  "You changed files but did not verify them.",
  "Run diagnostics_check and the tests or checks that cover the change, fix what they report, then give the final summary.",
].join(" ");

const SUBAGENT_BLOCKED_TOOLS = new Set([
  "spawn_subagents",
  "task_create",
  "task_dispatch",
  "task_cancel",
  "task_merge",
  "task_wait",
  "question",
]);

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
  private readonly lastSkillReload = new Map<string, number>();
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
  private branch: string | undefined;
  private globalRules = "";
  private projectContext: ProjectContext | undefined;
  private readonly taskRequests = new Map<string, AgentTaskRequest>();
  private readonly pendingDiagnostics = new Map<string, string>();
  private questionHandler: QuestionHandler | undefined;

  constructor(options: AgentOrchestratorOptions) {
    this.router = options.router;
    this.snapshots = options.snapshots;
    this.rules = options.rules;
    this.database = options.database;
    this.lsp = options.lsp;
    this.hashEditLifecycle = options.hashEditLifecycle;
    this.root = options.repoRoot ?? globalThis.process.cwd();
    this.maxTurns = options.maxTurns ?? 40;
    this.contextTokenBudget = options.contextTokenBudget ?? 200_000;
    this.compactionConfig =
      options.config?.compaction ?? { auto: true, keep_tokens: 20_000, reserve_tokens: 16_384 };
    this.webSearchConfig = options.config?.websearch ?? { enabled: true, provider: "random" };
    this.webFetchConfig = options.config?.webfetch ?? { enabled: true };
    this.promptStyle = options.config?.prompt?.style ?? "auto";
    this.permissions = options.permissions ?? new GranularPermissionEngine({ repoRoot: this.root });
    this.questionHandler = options.onQuestion;
    this.registry = new ToolRegistry({ permissions: this.permissions });
    this.hindsight = new HindsightMemory(options.database);
    this.hooks = new HookRunner({ hooks: options.config?.hooks, cwd: this.root });
    this.advisor = new AdvisorReviewer({ router: options.router, repoRoot: this.root });
    this.customCommands = new CustomCommandEngine({ repoRoot: this.root });
    this.specialistAgents = new SpecialistAgentRegistry({ repoRoot: this.root });
    this.skills = new SkillRegistry({ repoRoot: this.root });
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
      store: options.database,
    });
    this.registerDefaultTools();
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

  estimateContextOverhead(mode: AgentMode): number {
    const providerRef = this.router.getModeModel(mode);
    const compact = this.useCompactPrompt(providerRef?.provider);
    const system = buildSystemPrompt({
      mode,
      repoRoot: this.root,
      branch: this.branch,
      agentInstructions: this.globalRules,
      projectSummary: this.projectContext?.summary,
      skillsIndex: this.skills.buildIndexPrompt({ compact }),
      compact,
    });
    const tools = filterToolsForMode(this.registry.listDefinitions(), mode);
    return estimateTextTokens(system) + estimateToolsTokens(tools);
  }

  getLastPromptInfo(sessionId?: string): PromptSnapshot | undefined {
    return sessionId ? this.lastPrompts.get(sessionId) : undefined;
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
    this.registry.register(
      createQuestionTool(async (request) => {
        if (!this.questionHandler) {
          throw new Error("The question tool is unavailable in this client.");
        }
        return this.questionHandler(request);
      }),
    );
    this.registry.register(createHashEditTool(lifecycle));
    this.registry.register(createCreateFileTool(lifecycle));
    this.registry.register(createDeleteFileTool(lifecycle));
    this.registry.register(createMoveFileTool(lifecycle));
    this.registry.register(createApplyUnifiedPatchTool(lifecycle));
    this.registry.register(createGlobFilesTool());
    this.registry.register(createGrepSearchTool());
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
    this.registry.register(createInspectImageTool({ router: this.router, repoRoot: this.root }));
    registerWebTools(this.registry, {
      search: this.webSearchConfig,
      fetch: this.webFetchConfig,
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
    return runWithTurnContext({ mode, sessionId }, () => this.executeInner(request, signal, sink, mode));
  }

  private async executeInner(
    request: AgentRunRequest,
    signal: AbortSignal | undefined,
    sink: (event: StreamEvent) => void,
    mode: AgentMode,
  ): Promise<AgentRunResult> {
    let activeSpecialist: SpecialistAgentProfile | undefined;
    if (typeof request.metadata?.agent === "string") {
      activeSpecialist = await this.specialistAgents.getAgent(request.metadata.agent as string);
    }

    let messages: Message[] = [...request.messages];
    const contract = modeContract(mode);
    const sessionId = typeof request.metadata?.session_id === "string" ? request.metadata.session_id : undefined;

    const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
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

    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const lastText =
      lastUserMsg?.content.map((b) => (b.type === "text" ? b.text : "")).join(" ") ?? "";
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
    if (!capabilities.vision) messages = stripImageBlocks(messages);

    const compact = this.useCompactPrompt(providerRef?.provider);
    const mentionedSkills = lastText ? parseSkillMentions(lastText, this.skills) : [];
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
    const namedSkills = compact && lastText ? matchSkillNames(lastText, this.skills) : [];
    const turnSkills = [
      ...new Map(
        [...mentionedSkills, ...namedSkills].map((document) => [document.name, document]),
      ).values(),
    ];
    const injectedTurnSkills = turnSkills.filter(
      (document) =>
        document.body.length <= MAX_SKILL_INJECTION_CHARS ||
        isSkillRelevant(document, lastText),
    );
    const pointerTurnSkills = turnSkills.filter(
      (document) => !injectedTurnSkills.includes(document),
    );
    const historicalMentions = messages
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        parseSkillMentions(
          message.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n"),
          this.skills,
        ),
      );
    const pointerHistorySkills = [...new Map(
      historicalMentions.map((document) => [document.name, document]),
    ).values()].filter(
      (document) =>
        !turnSkills.some((turnSkill) => turnSkill.name === document.name) &&
        document.body.length > MAX_SKILL_INJECTION_CHARS &&
        !isSkillRelevant(document, lastText),
    );
    const pointerStripSkills = [...new Map(
      [...pointerTurnSkills, ...pointerHistorySkills].map((document) => [
        document.name,
        document,
      ]),
    ).values()];
    for (const document of injectedTurnSkills) {
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
    const turnSkillBlock =
      injectedTurnSkills.length > 0
        ? await formatActiveSkills(injectedTurnSkills, MAX_SKILL_INJECTION_CHARS)
        : "";
    if (pointerStripSkills.length > 0) {
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.role !== "user") continue;
        const content = message.content.map((block) => {
          if (block.type !== "text") return block;
          let text = block.text;
          for (const document of pointerStripSkills) {
            const escaped = document.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            text = text.replace(
              new RegExp(`[@$]${escaped}(?![a-zA-Z0-9_-])`, "gi"),
              " ",
            );
          }
          const cleaned = text.replace(/\s{2,}/g, " ").trim();
          return { ...block, text: cleaned.length > 0 ? cleaned : block.text };
        });
        messages[index] = { ...message, content };
      }
    }
    const explicitWebIntent = /\b(web|internet|online|search|cari di web|cari online)\b/i.test(
      lastText,
    );
    const skillPriorityHint =
      injectedTurnSkills.length > 0 && !explicitWebIntent
        ? [
            "# Skill priority",
            `The request mentions ${injectedTurnSkills
              .map((document) => `"${document.name}"`)
              .join(", ")}. Follow the loaded skill instead of using web search.`,
          ].join("\n")
        : "";
    const projectQuestion =
      lastText.length > 0 && this.projectContext
        ? isProjectQuestion(lastText, this.projectContext)
        : false;
    const projectStudy = lastText.length > 0 ? isProjectStudyRequest(lastText) : false;
    const projectFileFollowUp = lastText.length > 0 ? isProjectFileFollowUp(lastText) : false;
    const projectReview =
      projectFileFollowUp &&
      /\b(bug|error|salah|masalah|adjust|perlu|review|cek|periksa|risiko|issue)\b/i.test(lastText);
    const projectEvidence = projectStudy || projectFileFollowUp
      ? await collectProjectEvidence(this.root)
      : undefined;
    const projectIdentity =
      lastText.length > 0 && this.projectContext
        ? isProjectIdentityQuestion(lastText, this.projectContext)
        : false;
    const capabilityQuestion = lastText.length > 0 ? isCapabilityQuestion(lastText) : false;
    const specificHint = projectStudy
      ? [
          "# Project study",
          "The user asked you to study the current project. Use the # Project evidence section as the source of truth. Inspect more files with read, search, and command tools only when the evidence is not enough.",
          "Do not write or replace code. Do not continue an earlier implementation. This is a read-only report.",
          "When done, write a concise report: what the project is, main modules and responsibilities, how the pieces fit together, and how to run and test it.",
          'Start with what the project is. Do not write a plan or a status update. Do not greet. Do not ask "How can I help you today?". Do not list every file you read. Reply in the user\'s language.',
        ].join("\n")
      : projectIdentity
        ? [
            "# Project question",
            "The user is asking what this project is. Answer from the # Project section in 2 to 4 sentences. Do not read AGENTS.md, do not list skills, and do not greet.",
          ].join("\n")
        : capabilityQuestion
          ? [
              "# Capability question",
              "The user is asking what you can do. Answer from the # Capability and # Project sections with 3 to 5 concise bullets. Do not read files, do not list raw tool names, and do not greet.",
            ].join("\n")
          : projectQuestion && !explicitWebIntent
            ? [
                "# Project question",
                "The user is asking about this project. Answer from the # Project section first. Only read local files if the summary does not contain the answer. Do not list tools or skills, and do not use web search.",
              ].join("\n")
            : "";
    const fileFollowUpHint = projectFileFollowUp
      ? [
          "# File follow-up",
          "The user is referring to a file discussed earlier in this session. Use the # Project evidence section and read the relevant file before answering.",
          "Do not ask the user to paste a file that is already present in the repository.",
          projectReview ? "Report findings. Do not rewrite the file unless the user asks for a fix." : "",
        ].join("\n")
      : "";
    const extraHints = [
      skillPriorityHint,
      specificHint,
      fileFollowUpHint,
      projectEvidence?.text,
      turnSkillBlock,
    ]
      .filter(Boolean)
      .join("\n\n");

    const contextWindowBase = capabilities.max_input ?? capabilities.context_window ?? this.contextTokenBudget;
    let contextWindow = contextWindowBase;
    const refreshContextWindow = (): number => {
      if (!providerRef?.provider) return contextWindow;
      try {
        const fresh = this.router.capabilitiesFor(providerRef.provider, providerRef.model);
        return fresh.max_input ?? fresh.context_window ?? contextWindow;
      } catch {
        return contextWindow;
      }
    };
    const loadedSkillDocs = this.activeSkillDocuments(sessionId);
    await this.reloadSkillsAfterCompaction(sessionId, messages, loadedSkillDocs);
    const promptBase = {
      mode,
      task: projectStudy ? ("study" as const) : projectReview ? ("review" as const) : undefined,
      repoRoot: this.root,
      branch: this.branch,
      agentInstructions: this.globalRules,
      specialistPrompt: activeSpecialist?.systemPrompt,
      projectSummary: this.projectContext?.summary,
      skillsIndex: this.skills.buildIndexPrompt({ compact }),
      extra: [request.system, extraHints].filter(Boolean).join("\n\n") || undefined,
      compact,
    };
    let system = buildSystemPrompt(promptBase);
    let tools = this.combineTools(request.tools, mode);
    if (!capabilities.tool_calling) tools = [];
    if (activeSpecialist) {
      tools = this.specialistAgents.filterTools(activeSpecialist, tools, this.readOnlyToolNames());
    }
    let overheadTokens = estimateTextTokens(system) + estimateToolsTokens(tools);
    const availableSkillCount = this.skills.listAvailableDocuments().length;
    const mentionedSkillNames = injectedTurnSkills.map((document) => document.name);
    const initialActiveSkillNames = mentionedSkillNames;
    const promptStyle = compact ? ("compact" as const) : ("full" as const);
    const capturePrompt = (documents: SkillDocument[]): void => {
      this.rememberPrompt(sessionId, {
        system,
        style: promptStyle,
        toolCount: tools.length,
        availableSkills: availableSkillCount,
        activeSkills: documents.map((document) => document.name),
        skillMentions: mentionedSkillNames,
        capturedAt: Date.now(),
      });
    };
    capturePrompt(injectedTurnSkills);
    sink({
      type: "prompt_preflight",
      style: promptStyle,
      system_chars: system.length,
      tool_count: tools.length,
      available_skills: availableSkillCount,
      active_skills: initialActiveSkillNames,
      skill_mentions: mentionedSkillNames,
    });

    const rebuildSystem = async (): Promise<void> => {
      system = buildSystemPrompt(promptBase);
      overheadTokens = estimateTextTokens(system) + estimateToolsTokens(tools);
      capturePrompt(injectedTurnSkills);
    };

    const skillPolicy = new SkillToolPolicy(SKILL_ALWAYS_ALLOWED_TOOLS);
    const activatedSkills = new Set<string>();
    for (const document of [...loadedSkillDocs, ...turnSkills]) {
      activatedSkills.add(document.name);
      if (document.allowedTools !== undefined) skillPolicy.activate(document.allowedTools);
    }
    const totals = zeroUsage();
    let finishReason: FinishReason = "stop";
    let ultraworkNudges = 0;
    let verifyNudges = 0;
    let projectNudged = false;
    let editedThisTurn = false;
    let verifiedThisTurn = false;
    let measuredContext: { messageCount: number; promptTokens: number } | undefined;
    const bufferStudyTokens = projectStudy || projectFileFollowUp;

    const specialistBudget = activeSpecialist?.thinkingBudget ?? 0;
    const capabilityBudget = capabilities.reasoning ? (capabilities.reasoning_budget_max ?? 8192) : 0;
    const reasoningBudget = Math.max(specialistBudget, capabilityBudget);
    const outputCap = Math.min(capabilities.max_output ?? 32_000, 256_000);
    const defaultOutput = reasoningBudget > 0 ? Math.max(outputCap, reasoningBudget + 2048) : outputCap;
    const requestedMaxTokens = request.max_tokens ?? defaultOutput;
    const estimatePromptTokens = (): number => {
      const estimated =
        messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + overheadTokens;
      if (!measuredContext || measuredContext.messageCount > messages.length) return estimated;
      let trailingTokens = 0;
      for (let index = measuredContext.messageCount; index < messages.length; index += 1) {
        trailingTokens += estimateMessageTokens(messages[index]);
      }
      return measuredContext.promptTokens + trailingTokens;
    };
    const measuredPromptTokens = (): number | undefined =>
      measuredContext ? estimatePromptTokens() : undefined;
    const outputHeadroom = (): number => {
      const reserve = Math.max(2048, Math.floor(contextWindow * 0.02));
      return Math.max(1024, contextWindow - estimatePromptTokens() - reserve);
    };
    let forcedOutputLimit: number | undefined;
    let maxTokens = Math.max(1024, Math.min(requestedMaxTokens, outputCap, outputHeadroom()));
    let compactedRetry = false;
    let outputLimitContinues = 0;
    let outputLimitCompacted = false;
    let outputBudgetRetried = false;

    const projectStudyFallback = (originalText: string, fallback: string): string => {
      const trimmed = originalText.trim();
      if (trimmed.length >= 40 && !looksLikeNonAnswer(trimmed, this.projectContext, { allowPlan: mode === "plan" })) return trimmed;
      return fallback;
    };

    const retryProjectStudy = async (
      originalText: string,
      evidence: ProjectEvidence | undefined,
      unknownFiles: string[] = [],
      task = "The user asked you to study the project. Write a concise report in the user's language.",
    ): Promise<string> => {
      if (!this.projectContext && !evidence) return originalText;
      const fallbackProject = this.projectContext?.summary ?? "# Project\n- No project metadata available.";
      const fallback = `${fallbackProject}\n\nI read the available project files but could not finish the report in this turn. Send another message to continue.`;
      const retrySystem = [
        "You are Orchivox, a helpful coding agent.",
        "# Project",
        fallbackProject,
        evidence?.text ?? "",
        unknownFiles.length > 0
          ? `# Correction\nThese names were not found in the project and must not appear in the answer: ${unknownFiles.join(", ")}.`
          : "",
        "# Task",
        task,
        "Start with the answer. Include main modules, architecture, and how to run and test it when relevant.",
        "Use only file names that appear in the project evidence.",
        "Do not greet. Do not list the files you read. Do not describe the agent instructions or skills.",
        "Do not write a plan or a status update. Answer directly.",
      ]
        .filter(Boolean)
        .join("\n\n");
      const retryRequest = ChatRequestSchema.parse({
        system: retrySystem,
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
        return projectStudyFallback(originalText, fallback);
      }
      const candidate =
        stripThinkTags(text).trim().length > 0
          ? stripThinkTags(text).trim()
          : cleanReasoningAnswer(stripThinkTags(thinking));
      if (candidate.length === 0) return projectStudyFallback(originalText, fallback);
      if (looksLikeNonAnswer(candidate, this.projectContext, { allowPlan: mode === "plan" })) {
        return projectStudyFallback(originalText, fallback);
      }
      if (
        evidence &&
        (unknownProjectFiles(candidate, evidence).length > 0 || looksLikeMissingFileAnswer(candidate))
      ) {
        return fallback;
      }
      return candidate;
    };

    const retryAfterInternalDump = async (originalText: string): Promise<string> => {
      const retrySystem = [
        system,
        "# Correction",
        "The previous response leaked internal skill content or an internal gate report.",
        "Answer the user's actual question directly.",
        "Do not print skill bodies, skill file listings, XML wrappers, internal notes, or gate reports.",
        "Use the project evidence and tool results already present in the conversation.",
      ].join("\n\n");
      const retryRequest = ChatRequestSchema.parse({
        system: retrySystem,
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

    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      if (this.compactionConfig.auto) {
        const compaction = await compactMessages(messages, {
          provider,
          contextWindow,
          keepTokens: this.compactionConfig.keep_tokens,
          reserveTokens: this.compactionConfig.reserve_tokens,
          bufferTokens: this.compactionConfig.buffer_tokens,
          bufferRatio: this.compactionConfig.buffer_ratio,
          overheadTokens,
          contextTokens: measuredPromptTokens(),
          previousSummary: extractSummary(messages),
          onStart: () => sink({ type: "compaction_start", reason: "auto" }),
        });
        if (compaction.didCompact) {
          measuredContext = undefined;
          messages = compaction.messages;
          maxTokens =
            forcedOutputLimit ??
            Math.max(1024, Math.min(requestedMaxTokens, outputCap, outputHeadroom()));
          sink({
            type: "compaction",
            reason: "auto",
            before_tokens: compaction.beforeTokens,
            after_tokens: compaction.afterTokens,
            summary_tokens: compaction.summaryTokens,
            summary: compaction.summary,
            removed_messages: compaction.removedMessages,
            tail_start_message_id: compaction.tailStartMessageId,
          });
        }
      }

      const advisorNote = this.advisor.consumeNote();
      if (advisorNote) {
        sink({ type: "advisor_note", note: advisorNote, severity: "info" });
        messages.push(makeMessage(`turn-${turn}-advisor`, "system", advisorNote));
      }

      const guardWebTools =
        turn === 0 &&
        !explicitWebIntent &&
        (projectStudy || projectQuestion || (compact && injectedTurnSkills.length > 0));
      const forceNoTools = turn === 0 && (projectIdentity || capabilityQuestion);
      const turnTools = forceNoTools
        ? []
        : skillPolicy.filter(
            guardWebTools
              ? tools.filter((tool) => tool.name !== "web_search" && tool.name !== "web_fetch")
              : tools,
          );
      const requestMessageCount = messages.length;
      const chatRequest = ChatRequestSchema.parse({
        system,
        messages,
        tools: turnTools,
        tool_choice: forceNoTools ? "none" : turnTools.length > 0 ? request.tool_choice.mode : "none",
        max_tokens: maxTokens,
        temperature: request.temperature,
        top_p: request.top_p,
        stop_sequences: request.stop_sequences,
        reasoning_effort: capabilities.reasoning
          ? clampReasoningEffort(request.reasoning_effort, capabilities.reasoning_efforts)
          : undefined,
      });

      const accumulator = new TurnAccumulator();
      let turnError: string | undefined;
      let contextOverflow = false;
      let errorSunk = false;
      for await (const event of provider.streamChat(chatRequest, signal)) {
        switch (event.type) {
          case "token":
            accumulator.addText(event.text);
            if (!bufferStudyTokens) sink(event);
            break;
          case "thinking_token":
            accumulator.addThinking(event.text, event.signature);
            sink(event);
            break;
          case "tool_call_delta":
            accumulator.addDelta(event);
            sink(event);
            break;
          case "tool_call_ready":
            accumulator.finishTool(event);
            sink(event);
            break;
          case "usage":
            accumulateUsage(totals, event);
            if (event.prompt_tokens > 0) {
              measuredContext = {
                messageCount: requestMessageCount,
                promptTokens: event.prompt_tokens,
              };
            }
            break;
          case "error":
            turnError = event.message;
            if (isContextOverflow(event.message)) contextOverflow = true;
            if (!isAutoHandledProviderError(event.message)) {
              sink(event);
              errorSunk = true;
            }
            break;
          case "done":
            finishReason = event.finish_reason;
            break;
          case "rule_violation":
            sink(event);
            break;
          default:
            break;
        }
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
          contextOverflow = false;
          continue;
        }
      }

      if (contextOverflow && !compactedRetry) {
        compactedRetry = true;
        contextWindow = refreshContextWindow();
        const forced = await compactMessages(messages, {
          provider,
          contextWindow,
          keepTokens: this.compactionConfig.keep_tokens,
          reserveTokens: this.compactionConfig.reserve_tokens,
          bufferTokens: this.compactionConfig.buffer_tokens,
          bufferRatio: this.compactionConfig.buffer_ratio,
          overheadTokens,
          contextTokens: measuredPromptTokens(),
          previousSummary: extractSummary(messages),
          force: true,
          onStart: () => sink({ type: "compaction_start", reason: "retry" }),
        });
        if (forced.didCompact) {
          messages = forced.messages;
          measuredContext = undefined;
          maxTokens =
            forcedOutputLimit ??
            Math.max(1024, Math.min(requestedMaxTokens, outputCap, outputHeadroom()));
          sink({
            type: "compaction",
            reason: "retry",
            before_tokens: forced.beforeTokens,
            after_tokens: forced.afterTokens,
            summary_tokens: forced.summaryTokens,
            summary: forced.summary,
            removed_messages: forced.removedMessages,
            tail_start_message_id: forced.tailStartMessageId,
          });
          turnError = undefined;
          contextOverflow = false;
          continue;
        }
      }

      const assistantMessage = accumulator.toMessage(`turn-${turn}`);
      messages.push(assistantMessage);
      const toolUses = assistantMessage.content.filter((block) => block.type === "tool_use");

      if (toolUses.length === 0 && !turnError && !accumulator.hasTextOutput()) {
        const fallback = accumulator.reasoningOutput();
        if (fallback.trim().length > 0 && !bufferStudyTokens) {
          sink({ type: "token", text: fallback });
        }
      }

      if (toolUses.length === 0 || turnError) {
        if (!turnError && contract.enforceTodos) {
          const enforcement = this.todos.checkPendingTodos();
          if (enforcement.hasPending) {
            messages.push(makeMessage(`turn-${turn}-todo`, "user", enforcement.continuationPrompt));
            continue;
          }
        }
        if (!turnError && finishReason === "stop" && ultraworkNudges < contract.nudges) {
          ultraworkNudges += 1;
          const nudge = [
            "You are not finished yet.",
            "Verify the result with tools, finish any remaining work, and update the todo list.",
            "If everything is complete, reply with a short final summary.",
          ].join(" ");
          messages.push(makeMessage(`turn-${turn}-continue`, "user", nudge));
          continue;
        }
        if (
          !turnError &&
          contract.verifyEdits &&
          editedThisTurn &&
          !verifiedThisTurn &&
          verifyNudges < 1
        ) {
          verifyNudges += 1;
          messages.push(makeMessage(`turn-${turn}-verify`, "user", VERIFY_NUDGE));
          continue;
        }
        if (!turnError && finishReason === "length" && outputLimitContinues < MAX_OUTPUT_LIMIT_CONTINUES) {
          outputLimitContinues += 1;
          if (!outputLimitCompacted) {
            outputLimitCompacted = true;
            const hasPriorTurn = messages.filter((message) => message.role === "user").length > 1;
            const compacted = hasPriorTurn
              ? await compactMessages(messages, {
                  provider,
                  contextWindow,
                  keepTokens: this.compactionConfig.keep_tokens,
                  reserveTokens: this.compactionConfig.reserve_tokens,
                  bufferTokens: this.compactionConfig.buffer_tokens,
                  bufferRatio: this.compactionConfig.buffer_ratio,
                  overheadTokens,
                  contextTokens: measuredPromptTokens(),
                  previousSummary: extractSummary(messages),
                  force: true,
                  onStart: () => sink({ type: "compaction_start", reason: "output_limit" }),
                })
              : undefined;
            if (compacted?.didCompact) {
              messages = compacted.messages;
              measuredContext = undefined;
              maxTokens =
                forcedOutputLimit ??
                Math.max(1024, Math.min(requestedMaxTokens, outputCap, outputHeadroom()));
              sink({
                type: "compaction",
                reason: "output_limit",
                before_tokens: compacted.beforeTokens,
                after_tokens: compacted.afterTokens,
                summary_tokens: compacted.summaryTokens,
                summary: compacted.summary,
                removed_messages: compacted.removedMessages,
                tail_start_message_id: compacted.tailStartMessageId,
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
        if ((projectStudy || projectFileFollowUp) && !turnError) {
          const originalText = textOf(assistantMessage);
          const unknownFiles = projectEvidence ? unknownProjectFiles(originalText, projectEvidence) : [];
          const needsRetry =
            looksLikeNonAnswer(originalText, this.projectContext, { allowPlan: mode === "plan" }) ||
            (projectEvidence !== undefined &&
              (unknownFiles.length > 0 || looksLikeMissingFileAnswer(originalText)));
          let finalText = originalText;
          if (needsRetry) {
            finalText = await retryProjectStudy(
              originalText,
              projectEvidence,
              unknownFiles,
              projectStudy
                ? "The user asked you to study the project. Write a concise report in the user's language."
                : "The user asked a follow-up about a file from this session. Answer that question directly using the evidence. Do not ask the user to paste a file that is already in the repository.",
            );
          }
          if (finalText !== originalText) {
            finalMessage = makeMessage(assistantMessage.id, "assistant", finalText);
          }
        }
        if (!turnError) {
          const rawText = textOf(finalMessage);
          const hasHardDump = /<skill_content\b|<skill_files\b|<available_skills\b|<file\b/i.test(
            rawText,
          );
          const shouldRetryDump =
            hasHardDump || (looksLikeInternalDump(rawText) && !isDesignQuestion(lastText));
          const cleaned = shouldRetryDump
            ? await retryAfterInternalDump(rawText)
            : sanitizeAssistantText(rawText);
          const finalText =
            cleaned.length > 0
              ? cleaned
              : "The model returned internal metadata instead of an answer. Please retry.";
          if (finalText !== rawText) {
            finalMessage = makeMessage(assistantMessage.id, "assistant", finalText);
            sink({ type: "final_text", text: finalText });
          }
        }
        if (bufferStudyTokens && !turnError) {
          sink({ type: "token", text: textOf(finalMessage) });
        }
        if (turnError && !errorSunk) {
          const overflowFailure = contextOverflow && compactedRetry;
          sink({
            type: "error",
            code: overflowFailure ? "context_overflow" : "provider_adjusted",
            message: overflowFailure
              ? [
                  "Context overflow recovery failed after one compact-and-retry attempt.",
                  "Start a new session, reduce the request size, or switch to a model with a larger context window.",
                ].join(" ")
              : isAutoHandledProviderError(turnError)
                ? "provider request failed after automatic adjustment"
                : turnError,
            recoverable: false,
          });
        }
        await this.hooks.runOnStop({});
        const finalReason: FinishReason = turnError ? "error" : finishReason;
        sink(usageEvent(totals));
        sink({ type: "done", finish_reason: finalReason });
        return { message: finalMessage, usage: totals, finish_reason: finalReason };
      }

      for (const block of toolUses) {
        const call: ToolCall = { id: block.id, name: block.name, arguments: block.input };
        const filePath = extractFilePath(call.arguments);
        if (MUTATING_TOOL_NAMES.has(call.name)) editedThisTurn = true;
        if (
          VERIFY_TOOL_NAMES.has(call.name) ||
          (call.name === "bash" &&
            typeof call.arguments.command === "string" &&
            VERIFY_COMMAND.test(call.arguments.command))
        ) {
          verifiedThisTurn = true;
        }
        const toolStartedAt = Date.now();
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

        if (!skillPolicy.allows(call.name)) {
          messages.push(toolResultMessage(call, `blocked: the active skill does not allow the ${call.name} tool`, true));
          sink({
            type: "tool_end",
            id: call.id,
            name: call.name,
            status: "error",
            duration_ms: Date.now() - toolStartedAt,
            file_path: filePath,
            output: "blocked: the active skill does not allow this tool",
          });
          continue;
        }

        const pre = await this.hooks.runPreToolUse({ toolName: call.name, args: call.arguments, filePath });
        if (pre.allowed === false) {
          messages.push(toolResultMessage(call, `blocked: ${pre.reason ?? "pre tool use hook"}`, true));
          sink({
            type: "tool_end",
            id: call.id,
            name: call.name,
            status: "error",
            duration_ms: Date.now() - toolStartedAt,
            file_path: filePath,
            output: `blocked: ${pre.reason ?? "pre tool use hook"}`,
          });
          continue;
        }

        let skillDocument: SkillDocument | undefined;
        if (call.name === "skill") {
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
            sink({
              type: "skill_activated",
              name: document.name,
              allowed_tools: document.allowedTools ?? [],
              trigger: "tool",
            });
          }
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

        const result = await this.registry.run(call, mode);
        let content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
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
        });        if (post.notes?.length) content = `${content}\n${post.notes.join("\n")}`;

        if (filePath) {
          const diagnostics = this.pendingDiagnostics.get(filePath);
          if (diagnostics) {
            this.pendingDiagnostics.delete(filePath);
            content = `${content}\n${diagnostics}`;
          }
        }

        messages.push(toolResultMessage(call, content, result.is_error));
        if (skillDocument) {
          this.activateSkill(sessionId, skillDocument.name);
          await rebuildSystem();
        }
        if (filePath && mutates && contract.advisor) this.advisor.scheduleReview();
      }

      if (toolUses.length > 0 && !projectNudged) {
        if (projectStudy) {
          projectNudged = true;
          messages.push(
            makeMessage(
              `turn-${turn}-study`,
              "user",
              [
                "# Final answer",
                "You have some tool results. If you need more information, call more read, search, or command tools now. If a file is missing, continue with package.json and src/.",
                "Do not write a plan or a status update. When you have enough, write the project report.",
                "Start with what the project is. Include main modules, architecture, and how to run and test it.",
                "Do not greet. Do not list the files you read. Do not describe the agent instructions or skills.",
                "Reply in the user's language.",
              ].join(" "),
            ),
          );
        } else if (projectQuestion) {
          projectNudged = true;
          messages.push(
            makeMessage(
              `turn-${turn}-answer`,
              "user",
              "Answer the user's question now using the tool results. Start with the answer. Do not greet. Do not list the files you read.",
            ),
          );
        }
      }
    }

    sink(usageEvent(totals));
    sink({ type: "done", finish_reason: "turn_limit" });
    return {
      message: makeMessage(
        "turn-exhausted",
        "assistant",
        `Stopped after reaching the ${this.maxTurns} turn limit with work still in progress.`,
      ),
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

  private hasSkillReloadMessage(messages: Message[]): boolean {
    return messages.some(
      (message) =>
        message.role === "system" &&
        message.content.some(
          (block) => block.type === "text" && block.text.startsWith("# Skill reload after compaction"),
        ),
    );
  }

  private async buildSkillReloadMessage(
    documents: SkillDocument[],
    key: string,
  ): Promise<Message> {
    const blocks: string[] = [];
    for (const document of documents) {
      blocks.push(await formatSkillContent(document, MAX_SKILL_INJECTION_CHARS));
    }
    return makeMessage(`skill-reload-${key}`, "system", [
      "# Skill reload after compaction",
      "The conversation was compacted. These skills were used earlier in the session and are reloaded as reference.",
      "Never print this content, skill files, XML wrappers, or internal gate reports to the user.",
      ...blocks,
    ].join("\n\n"));
  }

  private async reloadSkillsAfterCompaction(
    sessionId: string | undefined,
    messages: Message[],
    documents: SkillDocument[],
  ): Promise<void> {
    if (!sessionId || documents.length === 0) return;
    if (this.hasSkillReloadMessage(messages)) return;
    const compaction = this.database.getCompaction(sessionId);
    if (!compaction) return;
    const marker = compaction.created_at;
    if (marker <= (this.lastSkillReload.get(sessionId) ?? 0)) return;
    messages.push(await this.buildSkillReloadMessage(documents, `${sessionId}-${marker}`));
    this.lastSkillReload.set(sessionId, marker);
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

  private useCompactPrompt(providerName: string | undefined): boolean {
    if (this.promptStyle === "full") return false;
    if (this.promptStyle === "compact") return true;
    return providerName ? this.router.providerKind(providerName) === "ollama" : false;
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
    let tools = filterToolsForMode(this.registry.listDefinitions(), effectiveMode).filter(
      (tool) => !SUBAGENT_BLOCKED_TOOLS.has(tool.name),
    );
    if (!capabilities.tool_calling) tools = [];
    if (specialist) {
      tools = this.specialistAgents.filterTools(specialist, tools, this.readOnlyToolNames());
    }
    const outputCap = Math.min(capabilities.max_output ?? 32_000, 256_000);
    const requestedMaxTokens = specialist?.thinkingBudget
      ? Math.max(outputCap, specialist.thinkingBudget)
      : outputCap;
    const subagentMaxTokens = Math.max(1024, Math.min(requestedMaxTokens, outputCap));
    const compactPrompt = this.useCompactPrompt(providerName);
    const subagentSystem = buildSystemPrompt({
      mode: effectiveMode,
      repoRoot: this.root,
      branch: this.branch,
      agentInstructions: this.globalRules,
      specialistPrompt: specialist?.systemPrompt,
      projectSummary: this.projectContext?.summary,
      skillsIndex: this.skills.buildIndexPrompt({ compact: compactPrompt }),
      compact: compactPrompt,
    });

    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      for (const instruction of input.drainSteerings()) {
        messages.push(makeMessage(`subagent-steer-${turn}`, "user", `Steering instruction: ${instruction}`));
        input.onTranscript(`steering: ${instruction}`);
      }

      const accumulator = new TurnAccumulator();
      const chatRequest = ChatRequestSchema.parse({
        system: subagentSystem,
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
        return { output: accumulator.textOutput(), usage: totals };
      }
      for (const block of toolUses) {
        const call: ToolCall = { id: block.id, name: block.name, arguments: block.input };
        input.onTranscript(`[tool] ${call.name}`);
        const result = await this.registry.run(call, effectiveMode);
        messages.push(
          toolResultMessage(call, typeof result.content === "string" ? result.content : JSON.stringify(result.content), result.is_error),
        );
      }
    }
    return { output: `subagent stopped after ${this.maxTurns} turns`, usage: totals };
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

  reasoningOutput(): string {
    return cleanReasoningAnswer(stripThinkTags(this.thinking));
  }

  toMessage(id: string): Message {
    const content: Message["content"] = [];
    const text = stripThinkTags(this.text);
    const reasoning = stripThinkTags(this.thinking);
    const answer = cleanReasoningAnswer(reasoning);
    const useReasoningAsText =
      this.drafts.size === 0 && text.trim().length === 0 && answer.trim().length > 0;
    if (reasoning.length > 0 && !useReasoningAsText) {
      content.push({
        type: "thinking",
        thinking: reasoning,
        ...(this.thinkingSignature ? { signature: this.thinkingSignature } : {}),
      });
    }
    if (useReasoningAsText) {
      content.push({ type: "text", text: answer });
    } else if (text.length > 0) {
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

function toolResultMessage(call: ToolCall, content: string, isError: boolean): Message {
  return {
    id: `tool-${call.id}`,
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

const COMMAND_OUTPUT_TOOLS = new Set(["bash", "run_sandbox_script", "bg_start", "bg_logs"]);
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

export function isContextOverflow(message: string): boolean {
  return /context length|context_length_exceeded|too many tokens|maximum context|prompt is too long|reduce the length of the messages|request too large|input length|input token count|maximum number of tokens|tokens? exceed|exceed(?:s|ed)? the (?:model'?s )?(?:maximum|limit)|exceeds? the context|over the context limit/i.test(
    message,
  );
}

function isOutputBudgetError(message: string): boolean {
  return /requested\s+\d+\s+output tokens|output tokens?.*(?:too large|exceed)|max_tokens.*(?:too large|exceed)/i.test(
    message,
  );
}

function isUnsupportedParamsError(message: string): boolean {
  return /UnsupportedParamsError|does not support (?:the )?(?:parameter|parameters|param|params)|unsupported (?:parameter|parameters|param|params)/i.test(
    message,
  );
}

function isAutoHandledProviderError(message: string): boolean {
  return isOutputBudgetError(message) || isUnsupportedParamsError(message) || isContextOverflow(message);
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

function usageEvent(usage: Usage): StreamEvent {
  return { type: "usage", ...usage };
}
