#!/usr/bin/env bun
import React from "react";
import { render } from "ink";

import {
  AgentGatewayServer,
  AgentRunRequestSchema,
  type AgentProfile,
  type AgentRunResult,
} from "./api/server";
import { AgentOrchestrator } from "./agent/orchestrator";
import type { ApprovalDecision, ApprovalRequest } from "./agent/permissions";
import { CollabRelay } from "./collab/relay";
import { loadConfig, type AppConfig } from "./config/loader";
import { LSPClient } from "./ide/lsp-client";
import { HindsightMemory } from "./memory/hindsight";
import { RulesLoader } from "./memory/rules-loader";
import { MemoryDatabase, type SessionRecord } from "./memory/sqlite";
import { McpClientManager } from "./mcp/client";
import { McpToolServer } from "./mcp/server";
import { InterceptedProvider, loadStreamRules, type StreamRule } from "./provider/interceptor";
import { ProviderRouter, type LLMProvider } from "./provider/router";
import { analyzeAndSplitCommits } from "./vcs/atomic-commit";
import { SnapshotManager, type RestoreResult } from "./vcs/snapshot";
import { runGit } from "./vcs/git";
import { WorktreeManager } from "./vcs/worktree";
import { installSynchronizedOutput, OrchivoxApp, type ChatEntryView, type InputAction } from "./tui/app";
import type { HashlineLifecycle } from "./tools/hashline-edit";
import type { ThemeName } from "./tui/theme";
import { WorkspaceTrustManager } from "./security/workspace-trust";
import { WorkspaceTrustPrompt } from "./tui/trust-modal";
import type { ReasoningEffortLevel } from "./tui/command-palette";
import { AgentModeSchema, type AgentMode, type Message } from "./types/schema";

export interface CliOptions {
  command: "tui" | "serve" | "prompt" | "mcp";
  port?: number;
  prompt?: string;
  format: "text" | "json";
  mode: AgentMode;
  help: boolean;
  trust?: boolean;
}

export interface RuntimeHandle {
  config: AppConfig;
  orchestrator: AgentOrchestrator;
  router: ProviderRouter;
  database: MemoryDatabase;
  snapshots: SnapshotManager;
  plugins: { loaded: string[]; failed: Array<{ file: string; error: string }> };
  mcpServers: string[];
  close: () => Promise<void>;
}

const HELP_TEXT = [
  "orchivox - personal AI coding agent",
  "",
  "usage:",
  "  orchivox                             interactive TUI",
  "  orchivox --trust                     interactive TUI (skip trust prompt)",
  '  orchivox serve [--port 8080]         inbound OpenAPI and OpenClaude gateway',
  '  orchivox -p "task" [-f text|json] [--mode plan|build|ultrawork]',
  "                                       headless run for scripts and CI pipelines",
  "  orchivox mcp                         expose the agent tools as an MCP server on stdio",
  "",
  "flags: -p/--prompt, -f/--format, --mode, --port, --trust, -h/--help",
].join("\n");

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { command: "tui", format: "text", mode: "build", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--trust") options.trust = true;
    else if (arg === "serve") options.command = "serve";
    else if (arg === "mcp") options.command = "mcp";
    else if (arg === "-p" || arg === "--prompt") {
      options.command = "prompt";
      options.prompt = argv[++index] ?? "";
    } else if (arg === "-f" || arg === "--format") {
      const value = argv[++index];
      options.format = value === "json" ? "json" : "text";
    } else if (arg === "--mode") {
      const value = argv[++index];
      const parsed = AgentModeSchema.safeParse(value);
      if (parsed.success) options.mode = parsed.data;
    } else if (arg === "--port") {
      const value = Number(argv[++index]);
      if (Number.isInteger(value) && value >= 0) options.port = value;
    }
  }
  if (options.command === "prompt" && (options.prompt ?? "").trim().length === 0) {
    throw new Error('missing task text for -p, for example: orchivox -p "summarize the repo"');
  }
  return options;
}

export function modeToProfile(mode: AgentMode): AgentProfile {
  if (mode === "plan") return "orchivox-plan";
  if (mode === "ultrawork") return "orchivox-ultrawork";
  return "orchivox-main";
}

export function buildHashEditLifecycle(deps: { snapshots: SnapshotManager; lsp?: LSPClient }): HashlineLifecycle {
  return {
    onBeforeModify: async (filePath) => {
      await deps.snapshots.captureSnapshot(`before edit ${filePath}`);
    },
    onAfterModify: async (filePath, newContent) => {
      await deps.lsp?.notifyFileChanged(filePath, newContent);
    },
  };
}

export function formatHeadlessResult(result: AgentRunResult, format: "text" | "json"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const text = result.message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return `[thinking] ${block.thinking}`;
      if (block.type === "tool_use") return `[tool] ${block.name} ${JSON.stringify(block.input)}`;
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
  const usage = result.usage
    ? `tokens: ${result.usage.prompt_tokens + result.usage.completion_tokens}${
        result.usage.cost_usd !== undefined ? `, cost: $${result.usage.cost_usd.toFixed(4)}` : ""
      }`
    : "";
  return [text, usage].filter((part) => part.length > 0).join("\n");
}

class InterceptingRouter extends ProviderRouter {
  private readonly streamRules: StreamRule[];
  private readonly wrappers = new Map<LLMProvider, LLMProvider>();

  constructor(config: AppConfig, streamRules: StreamRule[]) {
    super(config);
    this.streamRules = streamRules;
  }

  get(role: "main" | "fast" | "advisor"): LLMProvider {
    return this.wrap(super.get(role));
  }

  provider(profileName: string, model?: string): LLMProvider {
    return this.wrap(super.provider(profileName, model));
  }

  private wrap(inner: LLMProvider): LLMProvider {
    const existing = this.wrappers.get(inner);
    if (existing) return existing;
    const wrapper = new InterceptedProvider(inner, { rules: this.streamRules });
    this.wrappers.set(inner, wrapper);
    return wrapper;
  }
}

export async function bootstrap(options: { repoRoot?: string } = {}): Promise<RuntimeHandle> {
  const root = options.repoRoot ?? globalThis.process.cwd();
  const config = await loadConfig(`${root}/.agent/config.yaml`);
  const database = new MemoryDatabase(`${root}/.agent/memory.db`);
  const rules = new RulesLoader({ rootPath: root });
  const streamRules = await loadStreamRules(`${root}/.agent/rules/stream_rules.yaml`);
  const router = new InterceptingRouter(config, streamRules);
  const snapshots = new SnapshotManager({ repoRoot: root });
  const worktrees = new WorktreeManager({ repoRoot: root });
  const lsp = await startLspClient(config, root);
  const lifecycle = buildHashEditLifecycle({ snapshots, lsp });

  const orchestrator = new AgentOrchestrator({
    router,
    worktrees,
    snapshots,
    rules,
    database,
    config,
    lsp,
    hashEditLifecycle: lifecycle,
    repoRoot: root,
  });
  const plugins = await orchestrator.initialize();
  const mcpClient = new McpClientManager({ registry: orchestrator.registry });
  const mcpReport = await mcpClient.connectAll(config.mcp.servers);

  return {
    config,
    orchestrator,
    router,
    database,
    snapshots,
    plugins,
    mcpServers: mcpReport.connected.map((entry) => entry.server),
    close: async () => {
      await orchestrator.bgProcesses.stopAll();
      await mcpClient.close();
      await lsp?.dispose();
      database.close();
    },
  };
}

async function startLspClient(config: AppConfig, root: string): Promise<LSPClient | undefined> {
  const entry = Object.values(config.lsp.servers).find((server) => server.enabled !== false);
  if (!entry) return undefined;
  const client = new LSPClient({ command: entry.command, args: entry.args, env: entry.env });
  try {
    await client.initialize(root);
    return client;
  } catch {
    await client.dispose().catch(() => undefined);
    return undefined;
  }
}

export async function promptWorkspaceTrust(workspacePath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const instance = render(
      React.createElement(WorkspaceTrustPrompt, {
        workspacePath,
        onTrust: () => {
          if (resolved) return;
          resolved = true;
          instance.unmount();
          resolve(true);
        },
        onExit: () => {
          if (resolved) return;
          resolved = true;
          instance.unmount();
          resolve(false);
        },
      }),
    );
  });
}

export async function main(
  argv: string[],
  io: { print?: (text: string) => void } = {},
): Promise<{ close: () => Promise<void> }> {
  const print = io.print ?? ((text: string) => console.log(text));
  const options = parseCliArgs(argv);
  if (options.help) {
    print(HELP_TEXT);
    return { close: async () => undefined };
  }

  if (options.command === "tui") {
    const cwd = globalThis.process.cwd();
    const trustManager = new WorkspaceTrustManager();
    if (!options.trust && !trustManager.isTrusted(cwd)) {
      const trusted = await promptWorkspaceTrust(cwd);
      if (!trusted) {
        return { close: async () => undefined };
      }
      trustManager.trust(cwd);
    }
  }

  const runtime = await bootstrap();

  if (options.command === "serve") {
    const gateway = new AgentGatewayServer({
      runner: runtime.orchestrator,
      apiKey: runtime.config.inbound_server.api_key,
    });
    const server = gateway.serve(options.port ?? runtime.config.inbound_server.port, "127.0.0.1");
    print(`inbound gateway listening on http://127.0.0.1:${server.port}`);
    return {
      close: async () => {
        server.stop(true);
        await runtime.close();
      },
    };
  }

  if (options.command === "mcp") {
    const toolServer = new McpToolServer({ registry: runtime.orchestrator.registry, mode: "build" });
    await toolServer.startStdio();
    return {
      close: async () => {
        await toolServer.close();
        await runtime.close();
      },
    };
  }

  if (options.command === "prompt") {
    const request = AgentRunRequestSchema.parse({
      profile: modeToProfile(options.mode),
      messages: [{ id: "prompt-1", role: "user", content: [{ type: "text", text: options.prompt ?? "" }] }],
      max_tokens: 4096,
    });
    const result = await runtime.orchestrator.runOnce(request);
    print(formatHeadlessResult(result, options.format));
    if (result.finish_reason === "error") process.exitCode = 1;
    await runtime.close();
    return { close: async () => undefined };
  }

  return runTuiSession(runtime, print);
}

async function runTuiSession(
  runtime: RuntimeHandle,
  print: (text: string) => void,
): Promise<{ close: () => Promise<void> }> {
  process.stdout.write("\x1b[?1049h\x1b[H\x1b[2J");
  const initialSession = runtime.database.createSession({
    title: "Interactive Session",
    mode: "build",
  });

  const state = {
    sessionId: initialSession.id,
    entries: [] as ChatEntryView[],
    messages: [] as Message[],
    mode: "build" as AgentMode,
    currentTheme: "tokyonight" as ThemeName,
    reasoningEffort: "medium" as ReasoningEffortLevel,
    streamingText: "",
    totalTokens: 0,
    totalCostUsd: 0,
    busy: false,
    counter: 0,
  };
  let relay: CollabRelay | undefined;
  let branch = "unknown";
  let pendingApproval: ApprovalRequest | undefined;
  let approvalResolver: ((decision: ApprovalDecision) => void) | undefined;
  let activeAbortController: AbortController | undefined;

  runtime.orchestrator.permissions.setApprovalHandler((request) => {
    return new Promise<ApprovalDecision>((resolve) => {
      pendingApproval = request;
      approvalResolver = resolve;
      rerender();
    });
  });

  try {
    branch = (await runGit(globalThis.process.cwd(), ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  } catch {
    branch = "unknown";
  }

  const pushEntry = (role: ChatEntryView["role"], text: string): void => {
    state.counter += 1;
    state.entries = [...state.entries, { id: `entry-${state.counter}`, role, text }];
  };

  const view = () => ({
    projectName: "orchivox-agent",
    branch,
    mcpCount: runtime.mcpServers.length,
    pluginCount: runtime.plugins.loaded.length,
    totalTokens: state.totalTokens,
    totalCostUsd: state.totalCostUsd,
    entries: state.entries,
    streamingText: state.streamingText,
    mode: state.mode,
    workers: runtime.orchestrator.subagents.listWorkers(),
    router: runtime.router,
    database: runtime.database,
    snapshots: runtime.snapshots,
    activeSessionId: state.sessionId,
    activeSessionMessages: state.messages,
    currentTheme: state.currentTheme,
    onThemeChange: (nextTheme: ThemeName) => {
      state.currentTheme = nextTheme;
      rerender();
    },
    reasoningEffort: state.reasoningEffort,
    onReasoningEffortChange: (effort: ReasoningEffortLevel) => {
      state.reasoningEffort = effort;
      pushEntry("system", `model reasoning level set to: ${effort}`);
      rerender();
    },
    onResumeSession: (sessionId: string) => {
      state.sessionId = sessionId;
      const msgs = runtime.database.loadMessages(sessionId);
      state.messages = msgs;
      state.entries = msgs.map((m, idx) => ({
        id: `entry-${idx + 1}`,
        role: m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user",
        text: m.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .filter(Boolean)
          .join(" "),
      }));
      const sess = runtime.database.getSession(sessionId);
      pushEntry("system", `resumed session: ${sess?.title ?? sessionId}`);
      rerender();
    },
    onForkSession: (forked: SessionRecord) => {
      state.sessionId = forked.id;
      const msgs = runtime.database.loadMessages(forked.id);
      state.messages = msgs;
      state.entries = msgs.map((m, idx) => ({
        id: `entry-${idx + 1}`,
        role: m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user",
        text: m.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .filter(Boolean)
          .join(" "),
      }));
      pushEntry("system", `session forked to: ${forked.title}`);
      rerender();
    },
    onRestoreSnapshot: (result: RestoreResult) => {
      pushEntry("system", `restored snapshot ${result.snapshotId}: ${result.restoredFiles.length} file(s) restored`);
      rerender();
    },
    pendingApproval,
    onApprovalDecision: (decision: ApprovalDecision) => {
      const resolver = approvalResolver;
      pendingApproval = undefined;
      approvalResolver = undefined;
      resolver?.(decision);
      rerender();
    },
    onModeChange: (next: AgentMode) => {
      state.mode = next;
      rerender();
    },
    onSteer: (workerId: string, instruction: string) => {
      try {
        runtime.orchestrator.subagents.steer(workerId, instruction);
        pushEntry("system", `steering sent to ${workerId}`);
      } catch (error) {
        pushEntry("system", `steering failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      rerender();
    },
    onKill: (workerId: string) => {
      runtime.orchestrator.subagents.kill(workerId);
      pushEntry("system", `kill sent to ${workerId}`);
      rerender();
    },
    onAbort: () => {
      if (activeAbortController) {
        activeAbortController.abort();
        pushEntry("system", "process cancelled by user.");
        rerender();
      }
    },
    todos: runtime.orchestrator.todos.list().map((t) => ({
      id: t.id,
      task: t.task,
      status: t.status,
      priority: t.priority,
    })),
    lspStatus: runtime.config.lsp.servers ? "active" : "disabled",
    mcpServers: runtime.mcpServers,
    onSubmit: (text: string, action: InputAction) => {
      void handleInput(text, action);
    },
  });

  const synced = installSynchronizedOutput({ onFrame: (frame) => void relay?.broadcast(frame) });
  const instance = render(React.createElement(OrchivoxApp, view()));
  const rerender = (): void => {
    instance.rerender(React.createElement(OrchivoxApp, view()));
  };

  const executeTurn = async (promptText: string, displayUserText?: string, targetAgent?: string): Promise<void> => {
    if (state.busy) {
      pushEntry("system", "a turn is already running");
      rerender();
      return;
    }
    pushEntry("user", displayUserText ?? promptText);
    const userMsg: Message = {
      id: `user-${Date.now().toString(36)}`,
      role: "user",
      content: [{ type: "text", text: promptText }],
      created_at: Date.now(),
    };
    state.messages = [...state.messages, userMsg];
    try {
      runtime.database.saveMessage(state.sessionId, userMsg);
    } catch {
      // Ignore database save error if session not found.
    }
    state.busy = true;
    state.streamingText = "";
    activeAbortController = new AbortController();
    rerender();
    try {
      const request = AgentRunRequestSchema.parse({
        profile: modeToProfile(state.mode),
        messages: state.messages,
        metadata: targetAgent ? { agent: targetAgent } : undefined,
        max_tokens: 4096,
      });
      let answer = "";
      for await (const event of runtime.orchestrator.runStream(request, activeAbortController.signal)) {
        if (event.type === "token") {
          answer += event.text;
          state.streamingText = answer;
        } else if (event.type === "thinking_token") {
          state.streamingText = `${answer}${answer ? "\n" : ""}${event.text}`;
        } else if (event.type === "advisor_note") {
          pushEntry("system", `[advisor note] ${event.note}`);
        } else if (event.type === "bg_process_update") {
          pushEntry("system", `[bg_process ${event.processId}] ${event.status}`);
        } else if (event.type === "usage") {
          state.totalTokens += event.prompt_tokens + event.completion_tokens;
          if (event.cost_usd !== undefined) state.totalCostUsd += event.cost_usd;
        }
      }
      pushEntry("assistant", answer || "(no output)");
      const assistantMsg: Message = {
        id: `assistant-${Date.now().toString(36)}`,
        role: "assistant",
        content: [{ type: "text", text: answer }],
        created_at: Date.now(),
      };
      state.messages = [...state.messages, assistantMsg];
      try {
        runtime.database.saveMessage(state.sessionId, assistantMsg);
      } catch {
        // Ignore database save error if session not found.
      }
    } catch (error) {
      pushEntry("system", `turn failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      activeAbortController = undefined;
      state.streamingText = "";
      state.busy = false;
      rerender();
    }
  };

  const handleCommand = async (command: string, args = "", raw = command): Promise<void> => {
    switch (command) {
      case "/help": {
        pushEntry("system", [
          "Built-in Slash Commands:",
          "  /mode [plan|build|ultrawork]       Inspect or switch active agent mode",
          "  /theme [tokyonight|catppuccin|...] Switch visual color theme preset",
          "  /reasoning [off|low|med|high|max]  Set reasoning / thinking intensity",
          "  /palette, /model                   Open command palette and model selector",
          "  /sessions, /fork, /timeline        Open session manager and VCS timeline",
          "  /hub                               Open Subagent Hub management panel",
          "  /undo, /redo                       Undo or redo snapshot file changes",
          "  /commit                            Analyze and split git changes into atomic commits",
          "  /compact                           Compact chat history context window",
          "  /plugins                           List loaded plugins",
          "  /collab                            Start live terminal sharing relay session",
          "  /clear                             Clear chat entry viewport",
          "  /exit, /quit                       Exit Orchivox",
          "",
          "Custom Commands (.agent/commands/):",
          "  /review [args]                     Review git changes with Oracle agent",
          "  /fix-tests [args]                  Run tests and fix failures with Sisyphus",
          "  /refactor <file> [args]            Perform structured code refactoring",
          "  /init-rules [args]                 Initialize agent rules in .agent/rules/",
          "",
          "Keyboard Shortcuts:",
          "  Tab Cycle mode · Ctrl+P Palette · Ctrl+S Sessions · Alt+A Subagents",
          "  Ctrl+B Toggle sidebar · Ctrl+O Toggle collapse · PgUp/PgDn Scroll",
        ].join("\n"));
        break;
      }
      case "/mode": {
        const targetMode = args.trim().toLowerCase();
        if (targetMode === "plan" || targetMode === "build" || targetMode === "ultrawork") {
          state.mode = targetMode as AgentMode;
          pushEntry("system", `agent mode switched to: ${targetMode}`);
        } else if (!targetMode) {
          pushEntry("system", `current mode: ${state.mode} (options: plan, build, ultrawork)`);
        } else {
          pushEntry("system", `invalid mode: "${targetMode}". Options: plan, build, ultrawork`);
        }
        break;
      }
      case "/theme": {
        const targetTheme = args.trim().toLowerCase();
        if (targetTheme === "tokyonight" || targetTheme === "catppuccin" || targetTheme === "gruvbox" || targetTheme === "monochrome") {
          state.currentTheme = targetTheme as ThemeName;
          pushEntry("system", `theme switched to: ${targetTheme}`);
        } else if (!targetTheme) {
          pushEntry("system", `current theme: ${state.currentTheme} (options: tokyonight, catppuccin, gruvbox, monochrome)`);
        } else {
          pushEntry("system", `unknown theme: "${targetTheme}". Options: tokyonight, catppuccin, gruvbox, monochrome`);
        }
        break;
      }
      case "/reasoning": {
        const targetReasoning = args.trim().toLowerCase();
        if (targetReasoning === "off" || targetReasoning === "low" || targetReasoning === "medium" || targetReasoning === "high" || targetReasoning === "max") {
          state.reasoningEffort = targetReasoning as ReasoningEffortLevel;
          pushEntry("system", `model reasoning level set to: ${targetReasoning}`);
        } else if (!targetReasoning) {
          pushEntry("system", `current reasoning level: ${state.reasoningEffort} (options: off, low, medium, high, max)`);
        } else {
          pushEntry("system", `invalid reasoning level: "${targetReasoning}". Options: off, low, medium, high, max`);
        }
        break;
      }
      case "/palette":
      case "/model": {
        pushEntry("system", "press Ctrl+P to open the command palette and model selector.");
        break;
      }
      case "/sessions": {
        pushEntry("system", "press Ctrl+S to open the session manager.");
        break;
      }
      case "/fork": {
        pushEntry("system", "press Ctrl+S and navigate to the Fork tab to branch the session.");
        break;
      }
      case "/timeline": {
        pushEntry("system", "press Ctrl+S and navigate to the Timeline tab for time-travel snapshots.");
        break;
      }
      case "/hub": {
        pushEntry("system", "press Alt+A to open the Subagent Hub.");
        break;
      }
      case "/undo": {
        try {
          const restored = await runtime.snapshots.undo();
          pushEntry("system", `undo: ${restored.snapshotId} restored ${restored.restoredFiles.length} file(s)`);
        } catch (error) {
          pushEntry("system", `undo failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }
      case "/redo": {
        try {
          const restored = await runtime.snapshots.redo();
          pushEntry("system", `redo: ${restored.snapshotId} restored ${restored.restoredFiles.length} file(s)`);
        } catch (error) {
          pushEntry("system", `redo failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }
      case "/commit": {
        try {
          const results = await analyzeAndSplitCommits(runtime.router.get("main"));
          pushEntry("system", results.length === 0 ? "nothing to commit" : `created ${results.length} commit(s): ${results.map((entry) => entry.message).join(" | ")}`);
        } catch (error) {
          pushEntry("system", `commit failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }
      case "/compact": {
        try {
          const memory = new HindsightMemory(runtime.database);
          state.messages = await memory.compactMessagesIfNeeded(state.messages, 200_000, runtime.router.get("main"));
          pushEntry("system", `compacted: ${state.messages.length} message(s) in context`);
        } catch (error) {
          pushEntry("system", `compact failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }
      case "/plugins": {
        const list = runtime.plugins.loaded.join(", ") || "none";
        pushEntry("system", `active plugins: ${list}`);
        break;
      }
      case "/collab": {
        if (relay?.getSession()) {
          pushEntry("system", `live session already running: ${relay.getSession()?.viewerUrl}`);
        } else {
          try {
            relay = new CollabRelay({
              token: crypto.randomUUID().replace(/-/g, ""),
              allowInput: true,
              onInput: (text) => {
                pushEntry("user", `[collab] ${text}`);
                rerender();
              },
            });
            const session = await relay.start();
            pushEntry("system", `live session: ${session.viewerUrl}`);
          } catch (error) {
            pushEntry("system", `collab relay failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        break;
      }
      case "/clear": {
        state.entries = [];
        break;
      }
      case "/exit":
      case "/quit": {
        pushEntry("system", "shutting down Orchivox...");
        rerender();
        cleanupSignals();
        return;
      }
      default: {
        try {
          const customCmd = await runtime.orchestrator.customCommands.getCommand(command);
          if (customCmd) {
            const executed = await runtime.orchestrator.customCommands.executeCommand(command, args);
            if (executed) {
              if (executed.subtask) {
                const worker = runtime.orchestrator.subagents.spawnOne({
                  agent: executed.agent,
                  task: executed.prompt,
                  writeIsolation: true,
                  onComplete: (w) => {
                    pushEntry("system", `subtask ${w.id} (${w.status}): ${w.result?.output.slice(0, 100) ?? ""}`);
                    rerender();
                  },
                });
                pushEntry("system", `running /${customCmd.name} as subtask: ${worker.id}`);
              } else {
                await executeTurn(executed.prompt, raw, executed.agent);
              }
              break;
            }
          }
        } catch (error) {
          pushEntry("system", `custom command execution failed: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
        pushEntry("system", `unknown command: ${command}. Type /help for assistance.`);
      }
    }
    rerender();
  };

  const handleInput = async (text: string, action: InputAction): Promise<void> => {
    if (action.kind === "command") {
      await handleCommand(action.command, action.args ?? "", action.raw ?? text);
      return;
    }
    if (action.ultrawork) state.mode = "ultrawork";
    await executeTurn(text);
  };

  const cleanupSignals = () => {
    process.stdout.write("\x1b[?1049l");
    void runtime.close().then(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", cleanupSignals);
  process.on("SIGTERM", cleanupSignals);
  rerender();
  await instance.waitUntilExit();
  synced.uninstall();
  process.removeListener("SIGINT", cleanupSignals);
  process.removeListener("SIGTERM", cleanupSignals);
  process.stdout.write("\x1b[?1049l");
  await relay?.close();
  await runtime.close();
  print("session closed");
  return { close: async () => undefined };
}

if (import.meta.main) {
  void main(globalThis.process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    globalThis.process.exit(1);
  });
}
