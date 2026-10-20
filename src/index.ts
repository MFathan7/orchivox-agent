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
import { formatAppInfo, formatDoctor, getAppInfo, runUpdate } from "./app-info";
import { compactMessages, extractSummary } from "./agent/compaction";
import { generateSessionTitle, messageText } from "./agent/session-title";
import type { SkillDocument } from "./agent/skills";
import type { ApprovalDecision, ApprovalRequest } from "./agent/permissions";
import { CollabRelay } from "./collab/relay";
import { loadConfig, type AppConfig } from "./config/loader";
import { resolveConfigPaths, type ConfigSource } from "./config/paths";
import { saveModeReasoning, type ConfigMode } from "./config/writer";
import { LSPClient } from "./ide/lsp-client";
import { RulesLoader } from "./memory/rules-loader";
import { estimateMessageTokens } from "./memory/hindsight";
import { MemoryDatabase, type SessionRecord } from "./memory/sqlite";
import { McpClientManager } from "./mcp/client";
import { McpToolServer } from "./mcp/server";
import { InterceptedProvider, loadStreamRules, type StreamRule } from "./provider/interceptor";
import { subscribeLearnedLimits } from "./provider/limit-cache";
import { loadModelCatalogSync, refreshModelCatalog, type ModelCatalog } from "./provider/model-catalog";
import { primeRuntimeMetadata } from "./provider/runtime-metadata";
import { ProviderRouter, type LLMProvider } from "./provider/router";
import { ensureProjectState, resolveProjectState, type ProjectStatePaths } from "./runtime-paths";
import { analyzeAndSplitCommits } from "./vcs/atomic-commit";
import { SnapshotManager, type RestoreResult } from "./vcs/snapshot";
import { runGit } from "./vcs/git";
import { WorktreeManager } from "./vcs/worktree";
import { formatContextUsage, formatContextWindow, formatCost, formatTokenCount } from "./tui/format";
import {
  installSynchronizedOutput,
  OrchivoxApp,
  type ChatEntryView,
  type InputAction,
  type ThinkingSegmentView,
} from "./tui/app";
import { buildTranscriptEntries } from "./tui/transcript";
import type { FileAttachmentRef } from "./tui/composer";
import type { PendingQuestion } from "./tui/question-modal";
import type { QuestionAnswer } from "./tools/question";
import type { HashlineLifecycle } from "./tools/hashline-edit";
import type { ThemeName } from "./tui/theme";
import { basename, relative } from "node:path";
import { WorkspaceTrustManager } from "./security/workspace-trust";
import { WorkspaceTrustPrompt } from "./tui/trust-modal";
import type { ReasoningEffortLevel } from "./tui/command-palette";
import type { SessionModalTab } from "./tui/session-modal";
import { AgentModeSchema, type AgentMode, type Message } from "./types/schema";

export interface CliOptions {
  command: "tui" | "serve" | "prompt" | "mcp" | "update" | "doctor";
  port?: number;
  prompt?: string;
  format: "text" | "json";
  mode: AgentMode;
  help: boolean;
  version?: boolean;
  updateCheck?: boolean;
  updateBinary?: boolean;
  trust?: boolean;
  configPath?: string;
  secretsPath?: string;
}

export interface RuntimeHandle {
  config: AppConfig;
  configPath: string;
  secretsPath: string;
  configSource: ConfigSource;
  secretsSource: ConfigSource;
  orchestrator: AgentOrchestrator;
  router: ProviderRouter;
  database: MemoryDatabase;
  snapshots: SnapshotManager;
  statePaths: ProjectStatePaths;
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
  "  orchivox update [--check] [--binary] update the source checkout",
  "  orchivox doctor                      show entrypoint, config, and terminal diagnostics",
  "",
  "flags: -p/--prompt, -f/--format, --mode, --port, --trust, -h/--help",
  "       --version                       print the version and commit",
  "       --config <path>                 use a specific config file",
  "       --secrets <path>                use a specific secrets file",
].join("\n");

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { command: "tui", format: "text", mode: "build", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--version") options.version = true;
    else if (arg === "--check") options.updateCheck = true;
    else if (arg === "--binary") options.updateBinary = true;
    else if (arg === "--trust") options.trust = true;
    else if (arg === "--config") {
      const value = argv[++index];
      if (!value) throw new Error("--config requires a file path");
      options.configPath = value;
    } else if (arg === "--secrets") {
      const value = argv[++index];
      if (!value) throw new Error("--secrets requires a file path");
      options.secretsPath = value;
    } else if (arg === "serve") options.command = "serve";
    else if (arg === "mcp") options.command = "mcp";
    else if (arg === "update") options.command = "update";
    else if (arg === "doctor") options.command = "doctor";
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

export function reasoningEffortToRequest(level: string): string | undefined {
  if (level === "default") return undefined;
  if (level === "off" || level === "none") return "none";
  return level;
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

  constructor(config: AppConfig, streamRules: StreamRule[], catalog?: ModelCatalog) {
    super(config, { catalog });
    this.streamRules = streamRules;
  }

  get(role: "main" | "fast" | "advisor"): LLMProvider {
    return this.wrap(super.get(role));
  }

  provider(profileName: string, model?: string): LLMProvider {
    return this.wrap(super.provider(profileName, model));
  }

  refresh(): void {
    super.refresh();
    this.wrappers.clear();
  }

  private wrap(inner: LLMProvider): LLMProvider {
    const existing = this.wrappers.get(inner);
    if (existing) return existing;
    const wrapper = new InterceptedProvider(inner, { rules: this.streamRules });
    this.wrappers.set(inner, wrapper);
    return wrapper;
  }
}

export async function bootstrap(
  options: { repoRoot?: string; configPath?: string; secretsPath?: string } = {},
): Promise<RuntimeHandle> {
  const root = options.repoRoot ?? globalThis.process.cwd();
  const resolved = await resolveConfigPaths({
    cwd: root,
    configFlag: options.configPath,
    secretsFlag: options.secretsPath,
    env: globalThis.process.env,
  });
  const config = await loadConfig(resolved.configPath, globalThis.process.env, {
    secretsPath: resolved.secretsPath,
    fallbackSecretsPaths: resolved.fallbackSecretsPaths,
  });
  const statePaths = await ensureProjectState(root);
  const database = new MemoryDatabase(statePaths.memoryDb);
  const rules = new RulesLoader({ rootPath: root });
  const streamRules = await loadStreamRules(`${root}/.agent/rules/stream_rules.yaml`);
  const catalog = loadModelCatalogSync();
  await primeRuntimeMetadata(config.providers).catch(() => undefined);
  const router = new InterceptingRouter(config, streamRules, catalog);
  void refreshModelCatalog(catalog).then(() => router.refresh()).catch(() => undefined);
  const unsubscribeLearned = subscribeLearnedLimits(() => router.refresh());
  const snapshots = new SnapshotManager({ repoRoot: root, stateDir: statePaths.snapshotsDir });
  const worktrees = new WorktreeManager({
    repoRoot: root,
    worktreesDir: statePaths.worktreesDir,
  });
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
    configPath: resolved.configPath,
    secretsPath: resolved.secretsPath,
    configSource: resolved.configSource,
    secretsSource: resolved.secretsSource,
    orchestrator,
    router,
    database,
    snapshots,
    statePaths,
    plugins,
    mcpServers: mcpReport.connected.map((entry) => entry.server),
    close: async () => {
      unsubscribeLearned();
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

  if (options.version) {
    print(formatAppInfo(await getAppInfo()));
    return { close: async () => undefined };
  }

  if (options.command === "doctor") {
    print(await formatDoctor());
    return { close: async () => undefined };
  }

  if (options.command === "update") {
    const result = await runUpdate({
      check: options.updateCheck,
      binary: options.updateBinary,
    });
    print(result.output);
    return { close: async () => undefined };
  }

  if (options.command === "tui") {
    // Workspace trust is handled inside the single Orchivox TUI instance
    // to preserve process.stdin raw mode lifecycle and keyboard protocols.
  }

  const runtime = await bootstrap({
    configPath: options.configPath,
    secretsPath: options.secretsPath,
  });

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
    });
    const result = await runtime.orchestrator.runOnce(request);
    print(formatHeadlessResult(result, options.format));
    if (result.finish_reason === "error") process.exitCode = 1;
    await runtime.close();
    return { close: async () => undefined };
  }

  return runTuiSession(runtime, print, options);
}

async function runTuiSession(
  runtime: RuntimeHandle,
  print: (text: string) => void,
  options?: CliOptions,
): Promise<{ close: () => Promise<void> }> {
  // Kitty keyboard protocol (\x1b[>1u) + xterm modifyOtherKeys level 2 (\x1b[>4;2m):
  // makes Shift+Enter distinct from Enter across Foot, Kitty, WezTerm, Ptyxis, Ghostty.
  process.stdout.write("\x1b[?1049h\x1b[H\x1b[2J\x1b[>1u\x1b[>4;2m\x1b[?1000h\x1b[?1006h");

  const projectName = basename(globalThis.process.cwd());
  const root = globalThis.process.cwd();
  const trustManager = new WorkspaceTrustManager();
  let isWorkspaceTrusted = Boolean(options?.trust || trustManager.isTrusted(root));

  const state = {
    sessionId: undefined as string | undefined,
    sessionEpoch: 0,
    entries: [] as ChatEntryView[],
    messages: [] as Message[],
    mode: "build" as AgentMode,
    currentTheme: "tokyonight" as ThemeName,
    reasoningEffort: "default" as ReasoningEffortLevel,
    reasoningByMode: {
      plan: "default",
      build: "default",
      ultrawork: "default",
    } as Record<AgentMode, ReasoningEffortLevel>,
    streamingText: "",
    liveEntry: undefined as ChatEntryView | undefined,
    modifiedFiles: new Map<string, { path: string; additions: number; deletions: number }>(),
    totalTokens: 0,
    contextTokens: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCostUsd: 0,
    busy: false,
    counter: 0,
    helpOpen: false,
    modelsOpen: false,
    modelsView: "models" as "models" | "providers",
    skillsOpen: false,
    skills: runtime.orchestrator.skills.listDocuments() as SkillDocument[],
    activeSkills: [] as string[],
    hubTab: "workers" as "workers" | "tasks",
    paletteOpen: false,
    sessionTab: null as SessionModalTab | null,
    hubOpen: false,
    notice: undefined as string | undefined,
  };
  const normalizeReasoningForMode = (
    mode: AgentMode,
    preferred: ReasoningEffortLevel | string,
  ): ReasoningEffortLevel => {
    const options = runtime.router.reasoningOptionsForMode(mode);
    return (options.includes(preferred) ? preferred : "default") as ReasoningEffortLevel;
  };
  const normalizeAllReasoning = (): void => {
    for (const mode of ["plan", "build", "ultrawork"] as AgentMode[]) {
      state.reasoningByMode[mode] = normalizeReasoningForMode(mode, state.reasoningByMode[mode]);
    }
    state.reasoningEffort = state.reasoningByMode[state.mode];
  };
  for (const mode of ["plan", "build", "ultrawork"] as AgentMode[]) {
    const configured = runtime.config.modes[mode]?.reasoning;
    if (configured) state.reasoningByMode[mode] = configured as ReasoningEffortLevel;
  }
  normalizeAllReasoning();
  const setActiveMode = (next: AgentMode): void => {
    state.mode = next;
    state.reasoningEffort = normalizeReasoningForMode(next, state.reasoningByMode[next]);
  };
  const estimateContextTokens = (mode: AgentMode, messages: Message[]): number => {
    const overhead = runtime.orchestrator.estimateContextOverhead(mode);
    return overhead + messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  };
  let relay: CollabRelay | undefined;
  let branch = "unknown";
  let pendingApproval: ApprovalRequest | undefined;
  let approvalResolver: ((decision: ApprovalDecision) => void) | undefined;
  let pendingQuestion: PendingQuestion | undefined;
  let questionResolver: ((answer: QuestionAnswer) => void) | undefined;
  let activeAbortController: AbortController | undefined;

  runtime.orchestrator.permissions.setApprovalHandler((request) => {
    return new Promise<ApprovalDecision>((resolve) => {
      pendingApproval = request;
      approvalResolver = resolve;
      rerender();
    });
  });
  runtime.orchestrator.setQuestionHandler((request) => {
    return new Promise<QuestionAnswer>((resolve) => {
      pendingQuestion = request;
      questionResolver = resolve;
      rerender();
    });
  });

  try {
    branch = (await runGit(globalThis.process.cwd(), ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  } catch {
    branch = "unknown";
  }

  const pushEntry = (role: ChatEntryView["role"], text: string, extra?: Partial<ChatEntryView>): void => {
    state.counter += 1;
    state.entries = [...state.entries, { id: `entry-${state.counter}`, role, text, ...extra }];
  };

  const pushCompactionEntry = (compaction: {
    summary?: string;
    beforeTokens: number;
    afterTokens: number;
    removedMessages: number;
    auto?: boolean;
    status?: "running" | "done" | "error";
    error?: string;
  }): void => {
    pushEntry("compaction", compaction.summary ?? "", {
      compaction: {
        beforeTokens: compaction.beforeTokens,
        afterTokens: compaction.afterTokens,
        removedMessages: compaction.removedMessages,
        auto: compaction.auto,
        status: compaction.status ?? "done",
        error: compaction.error,
      },
    });
  };

  const sessionTitle = (text: string): string => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length === 0) return "Interactive Session";
    return clean.length > 48 ? `${clean.slice(0, 45).trimEnd()}...` : clean;
  };

  const ensureSession = (promptText: string): string => {
    if (state.sessionId) {
      try {
        runtime.database.updateSession(state.sessionId, { mode: state.mode });
      } catch {
        // Session metadata updates are best effort.
      }
      return state.sessionId;
    }
    const session = runtime.database.createSession({ title: sessionTitle(promptText), mode: state.mode });
    state.sessionId = session.id;
    state.sessionEpoch += 1;
    return session.id;
  };

  const titleGeneratedFor = new Set<string>();

  const maybeGenerateSessionTitle = async (sessionId: string, messages: Message[]): Promise<void> => {
    if (titleGeneratedFor.has(sessionId)) return;
    titleGeneratedFor.add(sessionId);

    const session = runtime.database.getSession(sessionId);
    if (!session) return;
    const firstUser = messages.find((message) => message.role === "user" && messageText(message).length > 0);
    if (!firstUser) return;
    if (session.title !== sessionTitle(messageText(firstUser))) return;

    const roles: Array<"fast" | "main"> = runtime.router.getRole("fast") ? ["fast", "main"] : ["main"];
    for (const role of roles) {
      let provider: LLMProvider;
      try {
        provider = runtime.router.get(role);
      } catch {
        continue;
      }
      const title = await generateSessionTitle({ messages, provider });
      if (!title) continue;
      try {
        runtime.database.updateSession(sessionId, { title });
        rerender();
      } catch {
        // Title generation is best effort.
      }
      return;
    }
  };

  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const setNotice = (text: string, ttlMs = 6000): void => {
    state.notice = text;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      if (state.notice === text) {
        state.notice = undefined;
        rerender();
      }
    }, ttlMs);
    rerender();
  };

  if (runtime.configSource === "default") {
    state.notice = "No config found. Use /connect to add a provider.";
  }

  const resetToWelcome = (): void => {
    state.sessionId = undefined;
    state.sessionEpoch += 1;
    state.entries = [];
    state.messages = [];
    state.liveEntry = undefined;
    state.streamingText = "";
    state.activeSkills = [];
    state.contextTokens = 0;
    state.totalTokens = 0;
    state.totalPromptTokens = 0;
    state.totalCompletionTokens = 0;
    state.totalCostUsd = 0;
    state.modifiedFiles.clear();
    state.counter = 0;
    state.busy = false;
  };

  const reloadSkills = async (): Promise<void> => {
    state.skills = await runtime.orchestrator.skills.load(true);
    rerender();
  };

  const view = () => ({
    projectName,
    branch,
    mcpCount: runtime.mcpServers.length,
    pluginCount: runtime.plugins.loaded.length,
    totalTokens: state.totalTokens,
    contextTokens: state.contextTokens,
    totalCostUsd: state.totalCostUsd,
    entries: state.entries,
    streamingText: state.streamingText,
    liveEntry: state.liveEntry,
    busy: state.busy,
    mode: state.mode,
    workers: runtime.orchestrator.subagents.listWorkers(),
    router: runtime.router,
    database: runtime.database,
    snapshots: runtime.snapshots,
    activeSessionId: state.sessionId ?? `draft-${state.sessionEpoch}`,
    activeSessionMessages: state.messages,
    currentTheme: state.currentTheme,
    statusMessage: state.notice,
    onStatusMessage: setNotice,
    helpOpen: state.helpOpen,
    onHelpOpenChange: (open: boolean) => {
      state.helpOpen = open;
      rerender();
    },
    modelsOpen: state.modelsOpen,
    modelsView: state.modelsView,
    onModelsOpenChange: (open: boolean) => {
      state.modelsOpen = open;
      rerender();
    },
    onModelsViewChange: (view: "models" | "providers") => {
      state.modelsView = view;
      rerender();
    },
    skillsOpen: state.skillsOpen,
    skills: state.skills,
    activeSkills: state.activeSkills,
    onSkillsOpenChange: (open: boolean) => {
      state.skillsOpen = open;
      rerender();
    },
    onReloadSkills: () => {
      void reloadSkills();
    },
    tasks: runtime.orchestrator.tasks.list(),
    hubTab: state.hubTab,
    onHubTabChange: (tab: "workers" | "tasks") => {
      state.hubTab = tab;
      rerender();
    },
    onCancelTask: (id: string) => {
      runtime.orchestrator.tasks.cancel(id);
      rerender();
    },
    onDispatchTasks: () => {
      runtime.orchestrator.tasks.dispatch();
      rerender();
    },
    onMergeTask: (id: string) => {
      setNotice(`merging ${id}...`, 10000);
      void runtime.orchestrator.tasks.merge(id).then((message) => {
        setNotice(message, 12000);
      });
    },
    configPath: runtime.configPath,
    secretsPath: runtime.secretsPath,
    onRoleChange: (role: "main" | "fast" | "advisor", provider: string, model: string) => {
      normalizeAllReasoning();
      setNotice(`${role} now uses ${provider} / ${model}`);
    },
    onModeModelChange: (mode: ConfigMode, provider: string, model: string) => {
      runtime.router.setModeModel(mode, provider, model);
      state.reasoningByMode[mode] = normalizeReasoningForMode(mode, state.reasoningByMode[mode]);
      if (state.mode === mode) state.reasoningEffort = state.reasoningByMode[mode];
      setNotice(`${mode} mode now uses ${provider} / ${model}`);
    },
    onModeReasoningChange: (mode: ConfigMode, reasoning: string) => {
      state.reasoningByMode[mode] = reasoning as ReasoningEffortLevel;
      if (state.mode === mode) state.reasoningEffort = reasoning as ReasoningEffortLevel;
      runtime.router.setModeReasoning(mode, reasoning);
      void saveModeReasoning(runtime.configPath, mode, reasoning).catch((error) => {
        setNotice(
          `Could not save reasoning: ${error instanceof Error ? error.message : String(error)}`,
          6000,
        );
      });
      setNotice(`${mode} mode thinking effort: ${reasoning}`);
    },
    paletteOpen: state.paletteOpen,
    onPaletteOpenChange: (open: boolean) => {
      state.paletteOpen = open;
      rerender();
    },
    sessionTab: state.sessionTab,
    onSessionTabChange: (tab: SessionModalTab | null) => {
      state.sessionTab = tab;
      rerender();
    },
    hubOpen: state.hubOpen,
    onHubOpenChange: (open: boolean) => {
      state.hubOpen = open;
      rerender();
    },
    onThemeChange: (nextTheme: ThemeName) => {
      state.currentTheme = nextTheme;
      rerender();
    },
    reasoningEffort: state.reasoningEffort,
    onReasoningEffortChange: (effort: ReasoningEffortLevel) => {
      state.reasoningEffort = effort;
      state.reasoningByMode[state.mode] = effort;
      runtime.router.setModeReasoning(state.mode, effort);
      void saveModeReasoning(runtime.configPath, state.mode, effort).catch((error) => {
        setNotice(
          `Could not save reasoning: ${error instanceof Error ? error.message : String(error)}`,
          6000,
        );
      });
      pushEntry("system", `model reasoning level set to: ${effort}`);
      rerender();
    },
    onResumeSession: (sessionId: string) => {
      if (state.busy) {
        setNotice("Cancel the running turn before switching sessions.", 8000);
        return;
      }
      state.sessionId = sessionId;
      state.sessionEpoch += 1;
      state.liveEntry = undefined;
      state.modifiedFiles.clear();
      const msgs = runtime.database.loadMessages(sessionId);
      const history = runtime.database.loadFullMessages(sessionId);
      state.messages = msgs;
      state.activeSkills = runtime.database.listSessionSkills(sessionId).map((skill) => skill.name);
      state.entries = buildTranscriptEntries(history, runtime.database.getCompaction(sessionId));
      state.counter = state.entries.length;
      const sess = runtime.database.getSession(sessionId);
      if (sess) setActiveMode(sess.mode);
      state.contextTokens = estimateContextTokens(state.mode, state.messages);
      state.totalTokens = sess?.totalTokens ?? 0;
      state.totalCostUsd = sess?.totalCostUsd ?? 0;
      state.totalPromptTokens = 0;
      state.totalCompletionTokens = 0;
      pushEntry("system", `resumed session: ${sess?.title ?? sessionId}`);
      rerender();
    },
    onNewSession: () => {
      void handleCommand("/new");
    },
    onForkSession: (forked: SessionRecord) => {
      if (state.busy) {
        setNotice("Cancel the running turn before forking the session.", 8000);
        return;
      }
      state.sessionId = forked.id;
      state.sessionEpoch += 1;
      setActiveMode(forked.mode);
      state.liveEntry = undefined;
      state.modifiedFiles.clear();
      state.totalTokens = forked.totalTokens ?? 0;
      state.totalCostUsd = forked.totalCostUsd ?? 0;
      state.totalPromptTokens = 0;
      state.totalCompletionTokens = 0;
      const msgs = runtime.database.loadMessages(forked.id);
      const history = runtime.database.loadFullMessages(forked.id);
      state.messages = msgs;
      state.contextTokens = estimateContextTokens(state.mode, state.messages);
      state.activeSkills = runtime.database.listSessionSkills(forked.id).map((skill) => skill.name);
      state.entries = buildTranscriptEntries(history, runtime.database.getCompaction(forked.id));
      state.counter = state.entries.length;
      pushEntry("system", `session forked to: ${forked.title}`);
      rerender();
    },
    onRestoreSnapshot: (result: RestoreResult) => {
      pushEntry("system", `restored snapshot ${result.snapshotId}: ${result.restoredFiles.length} file(s) restored`);
      rerender();
    },
    onSessionDeleted: (sessionId: string) => {
      if (state.sessionId !== sessionId) return;
      activeAbortController?.abort();
      if (questionResolver) {
        const resolve = questionResolver;
        questionResolver = undefined;
        pendingQuestion = undefined;
        resolve({ selected: [], cancelled: true });
      }
      if (approvalResolver) {
        const resolve = approvalResolver;
        approvalResolver = undefined;
        pendingApproval = undefined;
        resolve({ approved: false, choice: "deny", reason: "Active session deleted." });
      }
      resetToWelcome();
      setNotice("Session deleted. Starting a new draft.", 5000);
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
    pendingQuestion,
    onQuestionAnswer: (answer: QuestionAnswer) => {
      const resolver = questionResolver;
      pendingQuestion = undefined;
      questionResolver = undefined;
      resolver?.(answer);
      rerender();
    },
    onModeChange: (next: AgentMode) => {
      setActiveMode(next);
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
      if (questionResolver) {
        const resolve = questionResolver;
        questionResolver = undefined;
        pendingQuestion = undefined;
        resolve({ selected: [], cancelled: true });
      }
      if (approvalResolver) {
        const resolve = approvalResolver;
        approvalResolver = undefined;
        pendingApproval = undefined;
        resolve({ approved: false, choice: "deny", reason: "Cancelled by user." });
      }
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
    modifiedFiles: [...state.modifiedFiles.values()],
    lspStatus: runtime.config.lsp.servers ? "active" : "disabled",
    mcpServers: runtime.mcpServers,
    isWorkspaceTrusted,
    workspacePath: root,
    onTrustWorkspace: () => {
      isWorkspaceTrusted = true;
      trustManager.trust(root);
      rerender();
    },
    onExitWorkspace: () => {
      instance.unmount();
    },
    onSubmit: (text: string, action: InputAction, attachments?: FileAttachmentRef[]) => {
      void handleInput(text, action, attachments);
    },
  });

  const synced = installSynchronizedOutput({ onFrame: (frame) => void relay?.broadcast(frame) });
  let instance: ReturnType<typeof render>;
  instance = render(React.createElement(OrchivoxApp, view()));
  const rerender = (): void => {
    instance.rerender(React.createElement(OrchivoxApp, view()));
  };
  const unsubscribeCapabilities = runtime.router.onCapabilitiesChanged(rerender);

  const activityTimer = setInterval(() => {
    const workers = runtime.orchestrator.subagents.listWorkers();
    const tasks = runtime.orchestrator.tasks.list();
    const activeWorker = workers.some(
      (worker) =>
        worker.status === "queued" ||
        worker.status === "preparing" ||
        worker.status === "running" ||
        worker.status === "finalizing",
    );
    const activeTask = tasks.some((task) => task.state === "pending" || task.state === "running");
    if (activeWorker || activeTask) rerender();
  }, 750);

  const executeTurn = async (
    promptText: string,
    displayUserText?: string,
    targetAgent?: string,
    attachments?: FileAttachmentRef[],
  ): Promise<void> => {
    if (state.busy) {
      pushEntry("system", "a turn is already running");
      rerender();
      return;
    }
    if (state.sessionId && !runtime.database.getSession(state.sessionId)) {
      resetToWelcome();
      setNotice("The active session was deleted. Starting a new session.", 5000);
    }
    pushEntry("user", displayUserText ?? promptText);
    for (const attachment of attachments ?? []) {
      if (attachment.kind === "image" && attachment.error) {
        pushEntry("system", `image skipped: ${attachment.filePath} (${attachment.error})`);
      }
    }
    const sessionId = ensureSession(displayUserText ?? promptText);
    const imageBlocks = (attachments ?? [])
      .filter((attachment) => attachment.kind === "image" && attachment.base64 && attachment.mimeType)
      .map((attachment) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: attachment.mimeType as string,
          data: attachment.base64 as string,
        },
        path: attachment.filePath,
      }));
    const userMsg: Message = {
      id: `user-${Date.now().toString(36)}`,
      role: "user",
      content: [...imageBlocks, { type: "text", text: promptText }],
      created_at: Date.now(),
    };
    state.messages = [...state.messages, userMsg];
    try {
      runtime.database.saveMessage(sessionId, userMsg);
    } catch {
      // Ignore database save error if session not found.
    }
    state.busy = true;
    state.streamingText = "";
    const compactionConfig = runtime.config.compaction;
    if (compactionConfig.auto) {
      try {
        const provider = runtime.router.getMode(state.mode);
        const capabilities = runtime.router.capabilitiesForMode(state.mode);
        const compaction = await compactMessages(state.messages, {
          provider,
          contextWindow: capabilities.context_window,
          inputLimit: capabilities.max_input,
          outputLimit: capabilities.max_output,
          keepTokens: compactionConfig.keep_tokens,
          bufferTokens: compactionConfig.buffer_tokens,
          bufferRatio: compactionConfig.buffer_ratio,
          overheadTokens: runtime.orchestrator.estimateContextOverhead(state.mode),
          previousSummary: extractSummary(state.messages),
        });
        if (compaction.didCompact) {
          state.messages = compaction.messages;
          state.contextTokens = compaction.afterTokens;
          runtime.database.saveCompaction(sessionId, {
            summary: compaction.summary ?? "",
            tail_start_message_id: compaction.tailStartMessageId,
            before_tokens: compaction.beforeTokens,
            after_tokens: compaction.afterTokens,
            created_at: Date.now(),
            removed_messages: compaction.removedMessages,
            auto: true,
          });
          pushCompactionEntry({
            summary: compaction.summary,
            beforeTokens: compaction.beforeTokens,
            afterTokens: compaction.afterTokens,
            removedMessages: compaction.removedMessages,
            auto: true,
          });
          rerender();
        }
      } catch {
        // Compaction is best effort; the turn can still proceed.
      }
    }
    const turnMode = state.mode;
    const turnModel = runtime.router.getModeModel(turnMode)?.model;
    const turnStartedAt = Date.now();
    const liveEntry: ChatEntryView = {
      id: "live",
      role: "assistant",
      text: "",
      thinking: "",
      toolCalls: [],
      files: [],
      live: true,
      startedAt: turnStartedAt,
      mode: turnMode,
      model: turnModel,
    };
    const thinkingSegments: ThinkingSegmentView[] = [];
    let activeThinking: ThinkingSegmentView | undefined;
    let thinkingCounter = 0;
    const closeThinkingSegment = (): void => {
      if (!activeThinking) return;
      activeThinking.completedAt = Date.now();
      activeThinking = undefined;
    };
    const startThinkingSegment = (): ThinkingSegmentView => {
      const segment: ThinkingSegmentView = {
        id: `thinking-${Date.now().toString(36)}-${++thinkingCounter}`,
        text: "",
        startedAt: Date.now(),
        toolIndex: liveEntry.toolCalls?.length ?? 0,
      };
      thinkingSegments.push(segment);
      activeThinking = segment;
      liveEntry.thinkingSegments = thinkingSegments;
      return segment;
    };
    state.liveEntry = liveEntry;
    activeAbortController = new AbortController();
    let lastLiveRender = 0;
    const renderLive = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastLiveRender < 40) return;
      lastLiveRender = now;
      rerender();
    };
    rerender();
    try {
      const request = AgentRunRequestSchema.parse({
        profile: modeToProfile(turnMode),
        messages: state.messages,
        metadata: {
          ...(targetAgent ? { agent: targetAgent } : {}),
          session_id: sessionId,
        },
        reasoning_effort: reasoningEffortToRequest(state.reasoningEffort),
      });
      let answer = "";
      let sawUsage = false;
      let finishReason: string | undefined;
      let firstTokenAt: number | undefined;
      let lastTokenAt: number | undefined;
      let lastToolEndAt = turnStartedAt;
      let thinkingStartedAt: number | undefined;
      let thinkingCompletedAt: number | undefined;
      let completionTokens = 0;
      for await (const event of runtime.orchestrator.runStream(request, activeAbortController.signal)) {
        if (event.type === "token") {
          const now = Date.now();
          if (firstTokenAt === undefined) firstTokenAt = now;
          lastTokenAt = now;
          closeThinkingSegment();
          answer += event.text;
          liveEntry.text = answer;
          state.streamingText = answer;
          renderLive();
        } else if (event.type === "final_text") {
          answer = event.text;
          liveEntry.text = answer;
          state.streamingText = answer;
          renderLive(true);
        } else if (event.type === "thinking_token") {
          if (!event.text.startsWith("[tool]") && !event.text.startsWith("[snapshot]")) {
            if (thinkingStartedAt === undefined) thinkingStartedAt = Date.now();
            thinkingCompletedAt = Date.now();
            const segment = activeThinking ?? startThinkingSegment();
            segment.text += event.text;
            liveEntry.thinkingStartedAt = thinkingStartedAt;
            liveEntry.thinkingCompletedAt = thinkingCompletedAt;
            liveEntry.thinking = `${liveEntry.thinking ?? ""}${event.text}`;
            liveEntry.thinkingSegments = thinkingSegments;
          }
          renderLive();
        } else if (event.type === "tool_start") {
          closeThinkingSegment();
          liveEntry.toolCalls = [
            ...(liveEntry.toolCalls ?? []),
            {
              id: event.id,
              name: event.name,
              label: event.label,
              detail: event.file_path
                ? relative(root, event.file_path) || event.file_path
                : event.detail,
              argumentsSummary: event.arguments_summary,
              status: "running",
            },
          ];
          renderLive(true);
        } else if (event.type === "tool_end") {
          lastToolEndAt = Date.now();
          liveEntry.toolCalls = (liveEntry.toolCalls ?? []).map((call) =>
            call.id === event.id
              ? { ...call, status: event.status, durationMs: event.duration_ms }
              : call,
          );
          renderLive(true);
        } else if (event.type === "file_change") {
          const displayPath = relative(root, event.path) || event.path;
          liveEntry.files = [
            ...(liveEntry.files ?? []),
            {
              path: displayPath,
              oldText: event.old_text,
              newText: event.new_text,
              additions: event.additions,
              deletions: event.deletions,
            },
          ];
          const existing = state.modifiedFiles.get(event.path);
          state.modifiedFiles.set(event.path, {
            path: displayPath,
            additions: (existing?.additions ?? 0) + event.additions,
            deletions: (existing?.deletions ?? 0) + event.deletions,
          });
          renderLive(true);
        } else if (event.type === "prompt_preflight") {
          state.activeSkills = event.active_skills;
          renderLive(true);
        } else if (event.type === "skill_activated") {
          if (!state.activeSkills.includes(event.name)) {
            state.activeSkills = [...state.activeSkills, event.name];
          }
          const scope =
            event.allowed_tools.length > 0
              ? `tools limited to ${event.allowed_tools.join(", ")}`
              : "core read-only tools only";
          const trigger =
            event.trigger === "auto"
              ? " (auto)"
              : event.trigger === "mention"
                ? " (mention)"
                : "";
          pushEntry("system", `skill ${event.name} active${trigger} · ${scope}`);
          renderLive(true);
        } else if (event.type === "advisor_note") {
          pushEntry("system", `[advisor note] ${event.note}`);
          renderLive(true);
        } else if (event.type === "bg_process_update") {
          pushEntry("system", `[bg_process ${event.processId}] ${event.status}`);
          renderLive(true);
        } else if (event.type === "compaction") {
          state.contextTokens = event.after_tokens;
          pushCompactionEntry({
            summary: event.summary,
            beforeTokens: event.before_tokens,
            afterTokens: event.after_tokens,
            removedMessages: event.removed_messages,
            auto: event.reason !== "manual",
          });
          renderLive(true);
        } else if (event.type === "error") {
          pushEntry("system", `provider error: ${event.message}`);
          renderLive(true);
        } else if (event.type === "done") {
          finishReason = event.finish_reason;
        } else if (event.type === "usage") {
          const usedTokens = event.prompt_tokens + event.completion_tokens;
          sawUsage = true;
          completionTokens = event.completion_tokens;
          state.contextTokens = event.total_tokens ?? usedTokens;
          state.totalTokens += usedTokens;
          state.totalPromptTokens += event.prompt_tokens;
          state.totalCompletionTokens += event.completion_tokens;
          if (event.cost_usd !== undefined) state.totalCostUsd += event.cost_usd;
          try {
            runtime.database.addSessionUsage(sessionId, usedTokens, event.cost_usd ?? 0);
          } catch {
            // Usage tracking is best effort.
          }
          renderLive();
        }
      }
      const speedStart = Math.max(lastToolEndAt, firstTokenAt ?? lastToolEndAt);
      const streamedMs = (lastTokenAt ?? 0) - speedStart;
      const totalMs = (lastTokenAt ?? Date.now()) - turnStartedAt;
      const generationMs = streamedMs >= 500 ? streamedMs : Math.max(500, totalMs);
      const tokensPerSecond =
        completionTokens > 0 && generationMs > 0
          ? completionTokens / (generationMs / 1000)
          : undefined;
      closeThinkingSegment();
      pushEntry("assistant", answer || "(no output)", {
        thinking: liveEntry.thinking,
        thinkingSegments: thinkingSegments.map((segment) => ({ ...segment })),
        thinkingStartedAt,
        thinkingCompletedAt,
        toolCalls: liveEntry.toolCalls,
        files: liveEntry.files,
        mode: turnMode,
        model: turnModel,
        tokensPerSecond,
      });
      if (finishReason === "length") {
        pushEntry(
          "system",
          "response hit the output token limit; raise Max output in /models or send another message to continue",
        );
      } else if (finishReason === "turn_limit") {
        pushEntry("system", "agent turn limit reached; send another message to continue");
      }
      const assistantMsg: Message = {
        id: `assistant-${Date.now().toString(36)}`,
        role: "assistant",
        content: [{ type: "text", text: answer }],
        created_at: Date.now(),
        metadata: {
          mode: turnMode,
          model: turnModel,
          tokens_per_second: tokensPerSecond,
          completion_tokens: completionTokens,
          thinking_segments: thinkingSegments.map((segment) => ({ ...segment })),
          tool_calls: liveEntry.toolCalls ?? [],
        },
      };
      state.messages = [...state.messages, assistantMsg];
      if (!sawUsage) state.contextTokens = estimateContextTokens(state.mode, state.messages);
      try {
        runtime.database.saveMessage(sessionId, assistantMsg);
      } catch {
        // Ignore database save error if session not found.
      }
      void maybeGenerateSessionTitle(sessionId, [...state.messages]);
    } catch (error) {
      pushEntry("system", `turn failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      activeAbortController = undefined;
      state.liveEntry = undefined;
      state.streamingText = "";
      state.busy = false;
      rerender();
    }
  };

  const handleCommand = async (command: string, args = "", raw = command): Promise<void> => {
    switch (command) {
      case "/help": {
        state.helpOpen = true;
        rerender();
        break;
      }
      case "/plan": {
        setActiveMode("plan");
        setNotice("Mode: plan (read-only)");
        break;
      }
      case "/build": {
        setActiveMode("build");
        setNotice("Mode: build (approval on write)");
        break;
      }
      case "/ultrawork": {
        setActiveMode("ultrawork");
        setNotice("Mode: ultrawork (autonomous)");
        break;
      }
      case "/mode": {
        const targetMode = args.trim().toLowerCase();
        if (targetMode === "plan" || targetMode === "build" || targetMode === "ultrawork") {
          setActiveMode(targetMode as AgentMode);
          setNotice(`Mode: ${targetMode}`);
        } else if (!targetMode) {
          setNotice(`Current mode: ${state.mode}. Options: plan, build, ultrawork`);
        } else {
          setNotice(`Unknown mode "${targetMode}". Options: plan, build, ultrawork`, 8000);
        }
        break;
      }
      case "/theme": {
        const targetTheme = args.trim().toLowerCase();
        if (targetTheme === "tokyonight" || targetTheme === "catppuccin" || targetTheme === "gruvbox" || targetTheme === "monochrome") {
          state.currentTheme = targetTheme as ThemeName;
          setNotice(`Theme: ${targetTheme}`);
        } else if (!targetTheme) {
          setNotice(`Current theme: ${state.currentTheme}. Options: tokyonight, catppuccin, gruvbox, monochrome`);
        } else {
          setNotice(`Unknown theme "${targetTheme}". Options: tokyonight, catppuccin, gruvbox, monochrome`, 8000);
        }
        break;
      }
      case "/reasoning": {
        let targetReasoning = args.trim().toLowerCase();
        if (targetReasoning === "med") targetReasoning = "medium";
        const options = runtime.router.reasoningOptionsForMode(state.mode);
        if (targetReasoning && options.includes(targetReasoning)) {
          state.reasoningByMode[state.mode] = targetReasoning as ReasoningEffortLevel;
          state.reasoningEffort = state.reasoningByMode[state.mode];
          runtime.router.setModeReasoning(state.mode, targetReasoning);
          void saveModeReasoning(runtime.configPath, state.mode, targetReasoning).catch(
            (error) => {
              setNotice(
                `Could not save reasoning: ${error instanceof Error ? error.message : String(error)}`,
                6000,
              );
            },
          );
          setNotice(`Thinking effort: ${targetReasoning}`);
        } else if (!targetReasoning) {
          setNotice(
            `Current thinking effort (${state.mode}): ${state.reasoningEffort}. Options: ${options.join(", ")}`,
          );
        } else {
          setNotice(
            `Unknown thinking effort "${targetReasoning}". Options: ${options.join(", ")}`,
            8000,
          );
        }
        break;
      }
      case "/palette": {
        state.paletteOpen = true;
        rerender();
        break;
      }
      case "/models": {
        state.modelsView = "models";
        state.modelsOpen = true;
        rerender();
        break;
      }
      case "/connect": {
        state.modelsView = "providers";
        state.modelsOpen = true;
        rerender();
        break;
      }
      case "/sessions": {
        state.sessionTab = "sessions";
        rerender();
        break;
      }
      case "/fork": {
        state.sessionTab = "fork";
        rerender();
        break;
      }
      case "/timeline": {
        state.sessionTab = "timeline";
        rerender();
        break;
      }
      case "/hub": {
        state.hubTab = "workers";
        state.hubOpen = true;
        rerender();
        break;
      }
      case "/tasks": {
        state.hubTab = "tasks";
        state.hubOpen = true;
        rerender();
        break;
      }
      case "/skills": {
        await reloadSkills();
        state.skillsOpen = true;
        rerender();
        break;
      }
      case "/about": {
        const info = await getAppInfo();
        pushEntry(
          "system",
          [
            formatAppInfo(info),
            `config     ${runtime.configPath} (${runtime.configSource})`,
            `secrets    ${runtime.secretsPath} (${runtime.secretsSource})`,
            `state      ${runtime.statePaths.dataDir}`,
            `database   ${runtime.statePaths.memoryDb}`,
          ].join("\n"),
        );
        break;
      }
      case "/doctor": {
        pushEntry("system", await formatDoctor());
        break;
      }
      case "/update": {
        setNotice("Checking for updates...");
        try {
          const result = await runUpdate({ check: true });
          pushEntry("system", result.output);
        } catch (error) {
          pushEntry(
            "system",
            `update check failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
      case "/stats": {
        const sessionCount = runtime.database.listSessions().length;
        const snapshotHistory = await runtime.snapshots.getHistory();
        const snapshotCount = snapshotHistory.entries.length;
        const taskSummary = runtime.orchestrator.tasks.summary();
        const skillCount = runtime.orchestrator.skills.listDocuments().length;
        const modeModel = runtime.router.getModeModel(state.mode);
        const capabilities = runtime.router.capabilitiesForMode(state.mode);
        const contextWindow = capabilities.context_window;
        pushEntry("system", [
          "Session Statistics:",
          `  Active Session ID : ${state.sessionId ?? "(draft)"}`,
          `  Messages in Memory: ${state.messages.length} messages`,
          `  Total Token Usage : ${formatTokenCount(state.totalTokens, false)} tokens`,
          `    Input tokens    : ${formatTokenCount(state.totalPromptTokens, false)}`,
          `    Output tokens   : ${formatTokenCount(state.totalCompletionTokens, false)}`,
          `  Estimated Cost    : ${formatCost(state.totalCostUsd)}`,
          `  Active Agent Mode : ${state.mode}`,
          `  Mode Model        : ${modeModel ? `${modeModel.provider} / ${modeModel.model}` : "not configured"}`,
          `  Context Used      : ${formatContextUsage(state.contextTokens, contextWindow)}`,
          `  Context Window    : ${formatContextWindow(contextWindow)} (${capabilities.limit_sources?.context ?? capabilities.source ?? "default"})`,
          `  Input Limit       : ${capabilities.max_input ? `${formatContextWindow(capabilities.max_input)} (${capabilities.limit_sources?.input ?? "default"})` : "follows context"}`,
          `  Output Limit      : ${formatContextWindow(capabilities.max_output)} (${capabilities.limit_sources?.output ?? "default"})`,
          `  Reasoning Level   : ${state.reasoningEffort} (${state.mode})`,
          `  Visual Theme      : ${state.currentTheme}`,
          `  Connected MCP     : ${runtime.mcpServers.length > 0 ? runtime.mcpServers.join(", ") : "none"}`,
          `  Loaded Plugins    : ${runtime.plugins.loaded.length > 0 ? runtime.plugins.loaded.join(", ") : "none"}`,
          `  Skills Installed  : ${skillCount}`,
          `  Session Skills    : ${state.activeSkills.length > 0 ? state.activeSkills.join(", ") : "none"}`,
          `  Task Board        : ${taskSummary.completed}/${taskSummary.total} completed, ${taskSummary.running} running, ${taskSummary.blocked} blocked`,
          `  Git Branch        : ${branch}`,
          `  VCS Snapshots     : ${snapshotCount} snapshots recorded`,
          `  Saved Sessions    : ${sessionCount} total sessions in database`,
        ].join("\n"));
        rerender();
        break;
      }
      case "/debug": {
        const snapshot = runtime.orchestrator.getLastPromptInfo(state.sessionId);
        if (!snapshot) {
          pushEntry("system", "No prompt captured yet. Send a message first.");
          rerender();
          break;
        }
        pushEntry("system", [
          `Prompt style     : ${snapshot.style}`,
          `System chars     : ${snapshot.system.length}`,
          `Tools            : ${snapshot.toolCount}`,
          `Available skills : ${snapshot.availableSkills}`,
          `Session skills   : ${snapshot.activeSkills.join(", ") || "none"}`,
          `Skill mentions   : ${snapshot.skillMentions.join(", ") || "none"}`,
          "",
          "----- system prompt -----",
          snapshot.system,
        ].join("\n"));
        rerender();
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
        if (state.busy) {
          setNotice("Cancel the running turn before compacting.", 8000);
          break;
        }
        let provider: LLMProvider;
        try {
          provider = runtime.router.getMode(state.mode);
        } catch (error) {
          pushEntry("system", `compact failed: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
        const compactionConfig = runtime.config.compaction;
        const capabilities = runtime.router.capabilitiesForMode(state.mode);
        state.busy = true;
        setNotice("Compacting session context...", 30_000);
        rerender();
        try {
          const result = await compactMessages(state.messages, {
            provider,
            contextWindow: capabilities.context_window,
            inputLimit: capabilities.max_input,
            outputLimit: capabilities.max_output,
            keepTokens: compactionConfig.keep_tokens,
            bufferTokens: compactionConfig.buffer_tokens,
            bufferRatio: compactionConfig.buffer_ratio,
            overheadTokens: runtime.orchestrator.estimateContextOverhead(state.mode),
            previousSummary: extractSummary(state.messages),
            force: true,
          });
          if (!result.didCompact) {
            pushEntry(
              "system",
              `nothing to compact (${formatTokenCount(result.beforeTokens)} tokens)`,
            );
            setNotice("Nothing to compact", 4000);
          } else {
            state.messages = result.messages;
            state.contextTokens = result.afterTokens;
            if (state.sessionId) {
              runtime.database.saveCompaction(state.sessionId, {
                summary: result.summary ?? "",
                tail_start_message_id: result.tailStartMessageId,
                before_tokens: result.beforeTokens,
                after_tokens: result.afterTokens,
                created_at: Date.now(),
                removed_messages: result.removedMessages,
                auto: false,
              });
            }
            pushCompactionEntry({
              summary: result.summary,
              beforeTokens: result.beforeTokens,
              afterTokens: result.afterTokens,
              removedMessages: result.removedMessages,
              auto: false,
            });
            setNotice("Context compacted", 4000);
          }
        } catch (error) {
          pushEntry("system", `compact failed: ${error instanceof Error ? error.message : String(error)}`);
          setNotice("Compaction failed", 6000);
        } finally {
          state.busy = false;
          rerender();
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
      case "/new": {
        if (state.busy) {
          setNotice("Cancel the running turn before starting a new session.", 8000);
          break;
        }
        state.sessionId = undefined;
        state.sessionEpoch += 1;
        state.messages = [];
        state.entries = [];
        state.counter = 0;
        state.streamingText = "";
        state.liveEntry = undefined;
        state.activeSkills = [];
        state.modifiedFiles.clear();
        state.totalTokens = 0;
        state.contextTokens = 0;
        state.totalPromptTokens = 0;
        state.totalCompletionTokens = 0;
        state.totalCostUsd = 0;
        setNotice("Started a new draft session");
        rerender();
        break;
      }
      case "/clear": {
        state.entries = [];
        state.notice = undefined;
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

  const handleInput = async (
    text: string,
    action: InputAction,
    attachments?: FileAttachmentRef[],
  ): Promise<void> => {
    if (action.kind === "command") {
      await handleCommand(action.command, action.args ?? "", action.raw ?? text);
      return;
    }
    if (action.ultrawork) setActiveMode("ultrawork");
    await executeTurn(text, undefined, undefined, attachments);
  };

  const cleanupSignals = () => {
    if (noticeTimer) clearTimeout(noticeTimer);
    clearInterval(activityTimer);
    unsubscribeCapabilities();
    synced.uninstall();
    process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[>4;0m\x1b[<1u\x1b[?1049l");
    void runtime.close().then(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", cleanupSignals);
  process.on("SIGTERM", cleanupSignals);
  rerender();
  await instance.waitUntilExit();
  if (noticeTimer) clearTimeout(noticeTimer);
  clearInterval(activityTimer);
  unsubscribeCapabilities();
  synced.uninstall();
  process.removeListener("SIGINT", cleanupSignals);
  process.removeListener("SIGTERM", cleanupSignals);
  process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[>4;0m\x1b[<1u\x1b[?1049l");
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
