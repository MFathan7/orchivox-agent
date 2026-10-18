import type {
  AgentRunRequest,
  AgentRunResult,
  AgentTask,
  AgentTaskRequest,
  AgentProfile,
  IAgentRunner,
} from "../api/server";
import type { AppConfig, CompactionConfig } from "../config/loader";
import { structuredPatch } from "diff";
import { registerAstTools } from "../ide/ast-compress";
import { registerCodeIntelTools } from "../ide/code-intel";
import type { LSPClient } from "../ide/lsp-client";
import { HindsightMemory } from "../memory/hindsight";
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
import { CustomCommandEngine } from "./custom-commands";
import { HookRunner, type PluginLoadReport } from "./hooks";
import { GranularPermissionEngine } from "./permissions";
import { SpecialistAgentRegistry, type SpecialistAgentProfile } from "./specialist-agents";
import { SkillRegistry } from "./skills";
import { SubagentManager, type SubagentTaskInput, type SubagentTaskResult, type SubagentWorkerState } from "./subagent";
import { buildSystemPrompt } from "./system-prompt";
import { TaskBoard, type TaskSpawnInput, type TaskWorkerOutcome } from "./task-board";
import { runWithTurnContext } from "./turn-context";
import { SKILL_ALWAYS_ALLOWED_TOOLS, SkillToolPolicy } from "./skill-policy";
import { TodoEngine } from "./todo";
import { runGit } from "../vcs/git";

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
}

const PROFILE_MODES: Record<AgentProfile, AgentMode> = {
  "orchivox-main": "build",
  "orchivox-plan": "plan",
  "orchivox-ultrawork": "ultrawork",
};

const SUBAGENT_BLOCKED_TOOLS = new Set([
  "spawn_subagents",
  "task_create",
  "task_dispatch",
  "task_cancel",
  "task_merge",
  "task_wait",
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
  private readonly hindsight: HindsightMemory;
  private readonly lsp: LSPClient | undefined;
  private readonly hashEditLifecycle: HashlineLifecycle | undefined;
  private readonly root: string;
  private readonly maxTurns: number;
  private readonly contextTokenBudget: number;
  private readonly compactionConfig: CompactionConfig;
  private branch: string | undefined;
  private globalRules = "";
  private readonly taskRequests = new Map<string, AgentTaskRequest>();
  private readonly pendingDiagnostics = new Map<string, string>();

  constructor(options: AgentOrchestratorOptions) {
    this.router = options.router;
    this.snapshots = options.snapshots;
    this.rules = options.rules;
    this.lsp = options.lsp;
    this.hashEditLifecycle = options.hashEditLifecycle;
    this.root = options.repoRoot ?? globalThis.process.cwd();
    this.maxTurns = options.maxTurns ?? 40;
    this.contextTokenBudget = options.contextTokenBudget ?? 200_000;
    this.compactionConfig =
      options.config?.compaction ?? { auto: true, keep_tokens: 15_000, buffer_ratio: 0.1 };
    this.permissions = options.permissions ?? new GranularPermissionEngine({ repoRoot: this.root });
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

  async initialize(): Promise<PluginLoadReport> {
    await this.customCommands.ensureDefaults();
    await this.specialistAgents.ensureDefaults();
    await this.skills.load(true);
    this.globalRules = await this.rules.getGlobalRules();
    const branch = await runGit(this.root, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
    this.branch = branch.exitCode === 0 ? branch.stdout.trim() || undefined : undefined;
    return this.hooks.loadUserPlugins(this.registry);
  }

  estimateContextOverhead(mode: AgentMode): number {
    const system = buildSystemPrompt({
      mode,
      repoRoot: this.root,
      branch: this.branch,
      agentInstructions: this.globalRules,
      skillsIndex: this.skills.buildIndexPrompt(),
    });
    return estimateTextTokens(system) + estimateToolsTokens(this.registry.listDefinitions());
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

    if (!activeSpecialist && messages.length > 0) {
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const lastText = lastUserMsg?.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join(" ");
      if (lastText) {
        const mention = await this.specialistAgents.parseMention(lastText);
        if (mention?.profile) {
          activeSpecialist = mention.profile;
        }
      }
    }

    const requestedRole = activeSpecialist?.roleModel ?? "main";
    const roleName: "main" | "fast" | "advisor" =
      requestedRole === "advisor" || requestedRole === "fast" || requestedRole === "main"
        ? requestedRole
        : "main";
    const provider = this.router.get(roleName);
    const capabilities = this.router.capabilitiesForRole(roleName);
    if (!capabilities.vision) messages = stripImageBlocks(messages);
    const system = buildSystemPrompt({
      mode,
      repoRoot: this.root,
      branch: this.branch,
      agentInstructions: this.globalRules,
      specialistPrompt: activeSpecialist?.systemPrompt,
      skillsIndex: this.skills.buildIndexPrompt(),
      extra: request.system,
    });
    let tools = this.combineTools(request.tools);
    if (!capabilities.tool_calling) tools = [];
    if (activeSpecialist) {
      tools = this.specialistAgents.filterTools(activeSpecialist, tools, this.readOnlyToolNames());
    }
    const skillPolicy = new SkillToolPolicy(SKILL_ALWAYS_ALLOWED_TOOLS);
    const activatedSkills = new Set<string>();
    const totals = zeroUsage();
    let finishReason: FinishReason = "stop";
    let ultraworkNudges = 0;

    const specialistBudget = activeSpecialist?.thinkingBudget ?? 0;
    const capabilityBudget = capabilities.reasoning ? (capabilities.reasoning_budget_max ?? 8192) : 0;
    const reasoningBudget = Math.max(specialistBudget, capabilityBudget);
    const requestedMaxTokens = reasoningBudget > 0
      ? Math.max(request.max_tokens ?? 4096, reasoningBudget + 2048)
      : (request.max_tokens ?? 4096);
    const maxTokens = capabilities.max_output
      ? Math.min(requestedMaxTokens, capabilities.max_output)
      : requestedMaxTokens;
    const contextWindow = capabilities.context_window ?? this.contextTokenBudget;
    const overheadTokens = estimateTextTokens(system) + estimateToolsTokens(tools);
    let compactedRetry = false;

    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      if (this.compactionConfig.auto) {
        const compaction = await compactMessages(messages, {
          provider,
          contextWindow,
          keepTokens: this.compactionConfig.keep_tokens,
          bufferTokens: this.compactionConfig.buffer_tokens,
          bufferRatio: this.compactionConfig.buffer_ratio,
          overheadTokens,
          previousSummary: extractSummary(messages),
        });
        if (compaction.didCompact) {
          messages = compaction.messages;
          sink({
            type: "compaction",
            reason: "auto",
            before_tokens: compaction.beforeTokens,
            after_tokens: compaction.afterTokens,
            summary_tokens: compaction.summaryTokens,
            summary: compaction.summary,
          });
        }
      }

      const advisorNote = this.advisor.consumeNote();
      if (advisorNote) {
        sink({ type: "advisor_note", note: advisorNote, severity: "info" });
        messages.push(makeMessage(`turn-${turn}-advisor`, "system", advisorNote));
      }

      const turnTools = skillPolicy.filter(tools);
      const chatRequest = ChatRequestSchema.parse({
        system,
        messages,
        tools: turnTools,
        tool_choice: turnTools.length > 0 ? request.tool_choice.mode : "none",
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
      for await (const event of provider.streamChat(chatRequest, signal)) {
        switch (event.type) {
          case "token":
            accumulator.addText(event.text);
            sink(event);
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
            break;
          case "error":
            turnError = event.message;
            if (isContextOverflow(event.message)) contextOverflow = true;
            sink(event);
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

      if (contextOverflow && !compactedRetry && !accumulator.hasOutput()) {
        compactedRetry = true;
        const forced = await compactMessages(messages, {
          provider,
          contextWindow,
          keepTokens: this.compactionConfig.keep_tokens,
          bufferTokens: this.compactionConfig.buffer_tokens,
          bufferRatio: this.compactionConfig.buffer_ratio,
          overheadTokens,
          previousSummary: extractSummary(messages),
          force: true,
        });
        if (forced.didCompact) {
          messages = forced.messages;
          sink({
            type: "compaction",
            reason: "retry",
            before_tokens: forced.beforeTokens,
            after_tokens: forced.afterTokens,
            summary_tokens: forced.summaryTokens,
            summary: forced.summary,
          });
          continue;
        }
      }

      const assistantMessage = accumulator.toMessage(`turn-${turn}`);
      messages.push(assistantMessage);
      const toolUses = assistantMessage.content.filter((block) => block.type === "tool_use");

      if (toolUses.length === 0 || turnError) {
        if (!turnError && mode === "ultrawork") {
          const enforcement = this.todos.checkPendingTodos();
          if (enforcement.hasPending) {
            messages.push(makeMessage(`turn-${turn}-todo`, "user", enforcement.continuationPrompt));
            continue;
          }
          if (finishReason === "stop" && ultraworkNudges < 2) {
            ultraworkNudges += 1;
            const nudge = [
              "Continue in ULTRAWORK mode.",
              "Verify the result with tools, finish any remaining work, and update the todo list.",
              "If everything is complete, reply with a short final summary.",
            ].join(" ");
            messages.push(makeMessage(`turn-${turn}-ultrawork`, "user", nudge));
            continue;
          }
        }
        await this.hooks.runOnStop({});
        const finalReason: FinishReason = turnError ? "error" : finishReason;
        sink(usageEvent(totals));
        sink({ type: "done", finish_reason: finalReason });
        return { message: assistantMessage, usage: totals, finish_reason: finalReason };
      }

      for (const block of toolUses) {
        const call: ToolCall = { id: block.id, name: block.name, arguments: block.input };
        const filePath = extractFilePath(call.arguments);
        const toolStartedAt = Date.now();
        sink({
          type: "tool_start",
          id: call.id,
          name: call.name,
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
          });
          continue;
        }

        if (call.name === "skill") {
          const skillName = typeof call.arguments.name === "string" ? call.arguments.name : undefined;
          const document = skillName ? this.skills.get(skillName) : undefined;
          if (document?.allowedTools !== undefined && !activatedSkills.has(document.name)) {
            activatedSkills.add(document.name);
            skillPolicy.activate(document.allowedTools);
            sink({
              type: "skill_activated",
              name: document.name,
              allowed_tools: [...document.allowedTools],
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
        if (filePath && mutates && mode !== "plan") this.advisor.scheduleReview();
      }
    }

    sink(usageEvent(totals));
    sink({ type: "done", finish_reason: "length" });
    return {
      message: makeMessage(
        "turn-exhausted",
        "assistant",
        `Stopped after reaching the ${this.maxTurns} turn limit with work still in progress.`,
      ),
      usage: totals,
      finish_reason: "length",
    };
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

    const requestedRole = input.roleModel ?? specialist?.roleModel ?? "main";
    const role = requestedRole === "advisor" || requestedRole === "fast" ? requestedRole : "main";
    const provider =
      input.provider && input.model
        ? this.router.provider(input.provider, input.model)
        : this.router.get(role);
    const capabilities =
      input.provider && input.model
        ? this.router.capabilitiesFor(input.provider, input.model)
        : this.router.capabilitiesForRole(role);
    const messages: Message[] = [];
    const scope = input.worktreePath
      ? `Work only inside this directory: ${input.worktreePath}\n\n`
      : "";
    messages.push(makeMessage("subagent-task", "user", `${scope}${input.task}`));
    const totals = zeroUsage();

    let tools = this.registry.listDefinitions().filter((tool) => !SUBAGENT_BLOCKED_TOOLS.has(tool.name));
    if (!capabilities.tool_calling) tools = [];
    if (specialist) {
      tools = this.specialistAgents.filterTools(specialist, tools, this.readOnlyToolNames());
    }
    const requestedMaxTokens = specialist?.thinkingBudget ? Math.max(4096, specialist.thinkingBudget) : 4096;
    const subagentMaxTokens = capabilities.max_output
      ? Math.min(requestedMaxTokens, capabilities.max_output)
      : requestedMaxTokens;
    const effectiveMode = input.mode ?? (specialist?.readOnly ? "plan" : "build");
    const subagentSystem = buildSystemPrompt({
      mode: effectiveMode,
      repoRoot: this.root,
      branch: this.branch,
      agentInstructions: this.globalRules,
      specialistPrompt: specialist?.systemPrompt,
      skillsIndex: this.skills.buildIndexPrompt(),
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

  private combineTools(requestTools: AgentRunRequest["tools"]): ReturnType<ToolRegistry["listDefinitions"]> {
    const combined = this.registry.listDefinitions();
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
    return this.text;
  }

  toMessage(id: string): Message {
    const content: Message["content"] = [];
    if (this.thinking.length > 0) {
      content.push({
        type: "thinking",
        thinking: this.thinking,
        ...(this.thinkingSignature ? { signature: this.thinkingSignature } : {}),
      });
    }
    if (this.text.length > 0) content.push({ type: "text", text: this.text });
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

function summarizeArguments(args: Record<string, unknown>): string {
  const text = JSON.stringify(args);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function isContextOverflow(message: string): boolean {
  return /context length|context_length_exceeded|too many tokens|maximum context|prompt is too long|reduce the length of the messages|request too large/i.test(
    message,
  );
}

function clampReasoningEffort(
  requested: "low" | "medium" | "high" | undefined,
  supported: string[] | undefined,
): "low" | "medium" | "high" | undefined {  if (!requested) return undefined;
  if (!supported || supported.length === 0) return requested;
  const normalized = new Set(supported.map((value) => value.toLowerCase()));
  if (normalized.has(requested)) return requested;
  const order: Array<"low" | "medium" | "high"> = ["low", "medium", "high"];
  const requestedIndex = order.indexOf(requested);
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    if (normalized.has(order[index])) return order[index];
  }
  for (let index = requestedIndex + 1; index < order.length; index += 1) {
    if (normalized.has(order[index])) return order[index];
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
