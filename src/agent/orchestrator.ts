import type {
  AgentRunRequest,
  AgentRunResult,
  AgentTask,
  AgentTaskRequest,
  AgentProfile,
  IAgentRunner,
} from "../api/server";
import type { AppConfig } from "../config/loader";
import { registerAstTools } from "../ide/ast-compress";
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
  createHashEditTool,
  createReadFileTool,
  type HashlineLifecycle,
} from "../tools/hashline-edit";
import { ToolRegistry } from "../tools/registry";
import { PersistentShellTool } from "../tools/shell";
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
import { HookRunner, type PluginLoadReport } from "./hooks";
import { SubagentManager, type SubagentTaskInput, type SubagentTaskResult, type SubagentWorkerState } from "./subagent";
import { TodoEngine } from "./todo";

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
}

const PROFILE_MODES: Record<AgentProfile, AgentMode> = {
  "orchivox-main": "build",
  "orchivox-plan": "plan",
  "orchivox-ultrawork": "ultrawork",
};

const MODE_PROMPTS: Record<AgentMode, string> = {
  plan: [
    "You are in PLAN mode (Prometheus), acting as the lead architect.",
    "Interview the user with focused architecture questions when requirements are unclear,",
    "then produce a detailed implementation plan.",
    "Use only read-only tools and never modify files.",
  ].join(" "),
  build: [
    "You are in BUILD mode.",
    "Implement the requested changes completely, verify them with the available tools,",
    "and only stop once the work is done and verified.",
  ].join(" "),
  ultrawork: [
    "You are in ULTRAWORK mode.",
    "Track the work with todo_write and keep making progress with tools",
    "until every todo item is completed.",
  ].join(" "),
};

export class AgentOrchestrator implements IAgentRunner {
  readonly todos = new TodoEngine();
  readonly hooks: HookRunner;
  readonly advisor: AdvisorReviewer;
  readonly subagents: SubagentManager;
  readonly registry = new ToolRegistry();

  private readonly router: ProviderRouter;
  private readonly snapshots: SnapshotManager;
  private readonly rules: RulesLoader;
  private readonly hindsight: HindsightMemory;
  private readonly lsp: LSPClient | undefined;
  private readonly hashEditLifecycle: HashlineLifecycle | undefined;
  private readonly root: string;
  private readonly maxTurns: number;
  private readonly contextTokenBudget: number;
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
    this.hindsight = new HindsightMemory(options.database);
    this.hooks = new HookRunner({ hooks: options.config?.hooks, cwd: this.root });
    this.advisor = new AdvisorReviewer({ router: options.router, repoRoot: this.root });
    this.subagents = new SubagentManager({
      worktrees: options.worktrees,
      executor: (input) => this.executeSubagent(input),
    });
    this.registerDefaultTools();
  }

  async initialize(): Promise<PluginLoadReport> {
    return this.hooks.loadUserPlugins(this.registry);
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
    this.registry.register(createReadFileTool());
    this.registry.register(
      createHashEditTool({
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
      }),
    );
    this.registry.register(createGlobFilesTool());
    this.registry.register(createGrepSearchTool());
    this.registry.register(createDiffViewTool());
    this.registry.register(createJsonQueryTool());
    this.registry.register(new PersistentShellTool({ cwd: this.root }));
    registerAstTools(this.registry);
    this.todos.registerTools(this.registry);
    this.subagents.registerTools(this.registry);
    this.hindsight.registerTools(this.registry);
    if (this.lsp) this.lsp.registerTools(this.registry);
  }

  private async execute(
    request: AgentRunRequest,
    signal: AbortSignal | undefined,
    sink: (event: StreamEvent) => void,
  ): Promise<AgentRunResult> {
    const mode = PROFILE_MODES[request.profile];
    const provider = this.router.get("main");
    const system = [request.system, MODE_PROMPTS[mode]].filter(Boolean).join("\n\n");
    let messages: Message[] = [...request.messages];
    const tools = this.combineTools(request.tools);
    const totals = zeroUsage();
    let finishReason: FinishReason = "stop";

    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      messages = await this.hindsight.compactMessagesIfNeeded(messages, this.contextTokenBudget, provider);

      const advisorNote = this.advisor.consumeNote();
      if (advisorNote) messages.push(makeMessage(`turn-${turn}-advisor`, "system", advisorNote));

      const chatRequest = ChatRequestSchema.parse({
        system,
        messages,
        tools,
        tool_choice: request.tool_choice.mode,
        max_tokens: request.max_tokens ?? 4096,
        temperature: request.temperature,
        top_p: request.top_p,
        stop_sequences: request.stop_sequences,
      });

      const accumulator = new TurnAccumulator();
      let turnError: string | undefined;
      for await (const event of provider.streamChat(chatRequest, signal)) {
        switch (event.type) {
          case "token":
            accumulator.addText(event.text);
            sink(event);
            break;
          case "thinking_token":
            accumulator.addThinking(event.text);
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

      const assistantMessage = accumulator.toMessage(`turn-${turn}`);
      messages.push(assistantMessage);
      const toolUses = assistantMessage.content.filter((block) => block.type === "tool_use");

      if (toolUses.length === 0 || turnError) {
        if (!turnError && mode === "ultrawork") {
          const enforcement = this.todos.checkPendingTodos();
          if (enforcement.hasPending) {
            messages.push(makeMessage(`turn-${turn}-todo`, "user", enforcement.continuationPrompt));
            sink({ type: "thinking_token", text: enforcement.continuationPrompt });
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
        sink({ type: "thinking_token", text: `[tool] ${call.name} ${summarizeArguments(call.arguments)}` });

        const pre = await this.hooks.runPreToolUse({ toolName: call.name, args: call.arguments, filePath });
        if (pre.allowed === false) {
          messages.push(toolResultMessage(call, `blocked: ${pre.reason ?? "pre tool use hook"}`, true));
          sink({ type: "thinking_token", text: `[tool] ${call.name} blocked` });
          continue;
        }

        const mutates = this.registry.get(call.name)?.readOnly === false;
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

        messages.push(toolResultMessage(call, content, result.is_error));
        sink({
          type: "thinking_token",
          text: `[tool] ${call.name} ${result.is_error ? "failed" : "ok"}: ${firstLine(content)}`,
        });
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

  private async executeSubagent(input: SubagentTaskInput): Promise<SubagentTaskResult> {
    const provider = this.router.get("main");
    const messages: Message[] = [];
    const scope = input.worktreePath
      ? `Work only inside this directory: ${input.worktreePath}\n\n`
      : "";
    messages.push(makeMessage("subagent-task", "user", `${scope}${input.task}`));
    const totals = zeroUsage();

    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      for (const instruction of input.drainSteerings()) {
        messages.push(makeMessage(`subagent-steer-${turn}`, "user", `Steering instruction: ${instruction}`));
        input.onTranscript(`steering: ${instruction}`);
      }

      const accumulator = new TurnAccumulator();
      const chatRequest = ChatRequestSchema.parse({
        messages,
        tools: this.registry.listDefinitions(),
        max_tokens: 4096,
      });
      for await (const event of provider.streamChat(chatRequest, input.signal)) {
        if (event.type === "token") {
          accumulator.addText(event.text);
          input.onTranscript(event.text);
        } else if (event.type === "thinking_token") {
          accumulator.addThinking(event.text);
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
        const result = await this.registry.run(call, "build");
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
    if (!this.lsp) return undefined;
    try {
      const diagnostics = await this.lsp.notifyFileChanged(filePath, newContent);
      if (diagnostics.length === 0) return "lsp diagnostics: none";
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
  private readonly drafts = new Map<string, { id: string; name: string; argumentsText: string }>();
  private readonly ready = new Map<string, ToolCallReadyEvent>();

  addText(text: string): void {
    this.text += text;
  }

  addThinking(text: string): void {
    this.thinking += text;
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
    if (this.thinking.length > 0) content.push({ type: "thinking", thinking: this.thinking });
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
  const candidate = args.filePath ?? args.path;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function summarizeArguments(args: Record<string, unknown>): string {
  const text = JSON.stringify(args);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
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
