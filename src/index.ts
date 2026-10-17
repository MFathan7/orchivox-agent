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
import { CollabRelay } from "./collab/relay";
import { loadConfig, type AppConfig } from "./config/loader";
import { LSPClient } from "./ide/lsp-client";
import { HindsightMemory } from "./memory/hindsight";
import { RulesLoader } from "./memory/rules-loader";
import { MemoryDatabase } from "./memory/sqlite";
import { McpClientManager } from "./mcp/client";
import { McpToolServer } from "./mcp/server";
import { InterceptedProvider, loadStreamRules, type StreamRule } from "./provider/interceptor";
import { ProviderRouter, type LLMProvider } from "./provider/router";
import { analyzeAndSplitCommits } from "./vcs/atomic-commit";
import { SnapshotManager } from "./vcs/snapshot";
import { runGit } from "./vcs/git";
import { WorktreeManager } from "./vcs/worktree";
import { installSynchronizedOutput, OrchivoxApp, type ChatEntryView, type InputAction } from "./tui/app";
import type { HashlineLifecycle } from "./tools/hashline-edit";
import { AgentModeSchema, type AgentMode, type Message } from "./types/schema";

export interface CliOptions {
  command: "tui" | "serve" | "prompt" | "mcp";
  port?: number;
  prompt?: string;
  format: "text" | "json";
  mode: AgentMode;
  help: boolean;
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
  '  orchivox serve [--port 8080]         inbound OpenAPI and OpenClaude gateway',
  '  orchivox -p "task" [-f text|json] [--mode plan|build|ultrawork]',
  "                                       headless run for scripts and CI pipelines",
  "  orchivox mcp                         expose the agent tools as an MCP server on stdio",
  "",
  "flags: -p/--prompt, -f/--format, --mode, --port, -h/--help",
].join("\n");

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { command: "tui", format: "text", mode: "build", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") options.help = true;
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
  const state = {
    entries: [] as ChatEntryView[],
    messages: [] as Message[],
    mode: "build" as AgentMode,
    streamingText: "",
    totalTokens: 0,
    totalCostUsd: 0,
    busy: false,
    counter: 0,
  };
  let relay: CollabRelay | undefined;
  let branch = "unknown";
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
    onSubmit: (text: string, action: InputAction) => {
      void handleInput(text, action);
    },
  });

  const synced = installSynchronizedOutput({ onFrame: (frame) => void relay?.broadcast(frame) });
  const instance = render(React.createElement(OrchivoxApp, view()));
  const rerender = (): void => {
    instance.rerender(React.createElement(OrchivoxApp, view()));
  };
  const refresh = setInterval(rerender, 500);

  const handleCommand = async (command: string): Promise<void> => {
    switch (command) {
      case "/undo": {
        const restored = await runtime.snapshots.undo();
        pushEntry("system", `undo: ${restored.snapshotId} restored ${restored.restoredFiles.length} file(s)`);
        break;
      }
      case "/redo": {
        const restored = await runtime.snapshots.redo();
        pushEntry("system", `redo: ${restored.snapshotId} restored ${restored.restoredFiles.length} file(s)`);
        break;
      }
      case "/commit": {
        const results = await analyzeAndSplitCommits(runtime.router.get("main"));
        pushEntry("system", results.length === 0 ? "nothing to commit" : `created ${results.length} commit(s): ${results.map((entry) => entry.message).join(" | ")}`);
        break;
      }
      case "/compact": {
        const memory = new HindsightMemory(runtime.database);
        state.messages = await memory.compactMessagesIfNeeded(state.messages, 200_000, runtime.router.get("main"));
        pushEntry("system", `compacted: ${state.messages.length} message(s) in context`);
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
          break;
        }
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
        break;
      }
      case "/clear": {
        state.entries = [];
        break;
      }
      default:
        pushEntry("system", `unknown command: ${command}`);
    }
    rerender();
  };

  const handleInput = async (text: string, action: InputAction): Promise<void> => {
    if (action.kind === "command") {
      await handleCommand(action.command);
      return;
    }
    if (state.busy) {
      pushEntry("system", "a turn is already running");
      rerender();
      return;
    }
    if (action.ultrawork) state.mode = "ultrawork";
    pushEntry("user", text);
    state.messages = [
      ...state.messages,
      { id: `user-${Date.now().toString(36)}`, role: "user", content: [{ type: "text", text }] },
    ];
    state.busy = true;
    state.streamingText = "";
    rerender();
    try {
      const request = AgentRunRequestSchema.parse({
        profile: modeToProfile(state.mode),
        messages: state.messages,
        max_tokens: 4096,
      });
      let answer = "";
      for await (const event of runtime.orchestrator.runStream(request)) {
        if (event.type === "token") {
          answer += event.text;
          state.streamingText = answer;
        } else if (event.type === "thinking_token") {
          state.streamingText = `${answer}${answer ? "\n" : ""}${event.text}`;
        } else if (event.type === "usage") {
          state.totalTokens += event.prompt_tokens + event.completion_tokens;
          if (event.cost_usd !== undefined) state.totalCostUsd += event.cost_usd;
        }
      }
      pushEntry("assistant", answer || "(no output)");
      state.messages = [
        ...state.messages,
        { id: `assistant-${Date.now().toString(36)}`, role: "assistant", content: [{ type: "text", text: answer }] },
      ];
    } catch (error) {
      pushEntry("system", `turn failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      state.streamingText = "";
      state.busy = false;
      rerender();
    }
  };

  pushEntry("system", "orchivox ready. type a prompt, or / for commands.");
  rerender();
  await instance.waitUntilExit();
  clearInterval(refresh);
  synced.uninstall();
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
