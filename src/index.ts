#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { writeFileSync, writeSync } from "node:fs";

import {
  AgentGatewayServer,
  AgentRunRequestSchema,
  type AgentProfile,
  type AgentRunRequest,
  type AgentRunResult,
} from "./api/server";
import { AgentOrchestrator } from "./agent/orchestrator";
import { skillSourceKey, visibleSkillLoads } from "./agent/skill-state";
import { skillEnabled } from "./agent/skill-metadata";
import { logFreeze, startEventLoopMonitor } from "./agent/freeze-debug";
import { modeFromQuestionAnswer, modeTransitionReminder } from "./agent/modes";
import { buildReviewCommand, buildStudyCommand } from "./agent/task-commands";
import { currentTurnContext } from "./agent/turn-context";
import { appendErrorLog } from "./agent/error-log";
import {
  appendAnswerToken,
  createAnswerStream,
  replaceAnswer,
  takeAnswer,
} from "./agent/answer-stream";
import { formatAppInfo, formatDoctor, getAppInfo, isCompiledExecutable, runUpdate, userArgs } from "./app-info";
import { updateNotice, UPDATE_CHECK_INTERVAL } from "./installer/update-notice";
import { fetchUpdateCheck } from "./installer/update";
import { resolveInstallPaths } from "./installer/paths";
import { compactMessages, estimateRequestBytes, extractSummary, markPrunedToolResults } from "./agent/compaction";
import { formatTurnMetrics } from "./agent/turn-metrics";
import { shouldWarnLargeSession } from "./agent/session-warning";
import { isPlaceholderTitle, messageText } from "./agent/session-title";
import { SessionBackgroundJobs } from "./agent/session-background";
import { InputRouter, inputRoute, type SubmittedInput } from "./tui/input-routing";
import type { QueueMessage } from "./tui/queue-panel";
import type { BtwTurn } from "./agent/btw";
import { InputRunCancelled, SessionViewLease, interruptedRun, mainTurnEvents, mainTurnResult, withRunSignal, type InputRunContext, type InputRunResult } from "./agent/run-lifecycle";
import type { SkillDocument } from "./agent/skills";
import { dependencyDiagnostics, type SkillDependencyReport } from "./agent/skill-dependencies";
import { resetSkillAutocompleteCache } from "./tui/autocomplete";
import {
  GranularPermissionEngine,
  resolvePermissionRules,
  type ApprovalDecision,
} from "./agent/permissions";
import { CollabRelay } from "./collab/relay";
import {
  loadConfig,
  sharedModeModel,
  type AppConfig,
  type ApprovalPreset,
  type AutoDelegateMode,
  type BackgroundConfig,
  type DelegationPolicy,
  type LimitsConfig,
  type WorkerFallbackMode,
} from "./config/loader";
import { resolveConfigPaths, type ConfigSource } from "./config/paths";
import {
  clearModeModelSelections,
  saveActiveMode,
  saveBackground,
  saveMemoryEnabled,
  saveTurnLimits,
  saveDelegationPolicy,
  saveApprovalsPreset,
  saveAutoDelegate,
  saveAnimations,
  saveWorkerTimeout,
  saveWorkerFallback,
  saveModeReasoning,
  saveModeSteps,
  saveRoleSelection,
  saveTheme,
  type ConfigMode,
} from "./config/writer";
import { LSPClient } from "./ide/lsp-client";
import { RulesLoader } from "./memory/rules-loader";
import { estimateMessageTokens } from "./memory/hindsight";
import { MemoryDatabase, type SessionRecord } from "./memory/sqlite";
import { McpClientManager, type McpConnectionReport } from "./mcp/client";
import { mcpCommand, mcpCatalogView, MCP_CONNECTION_ACTIONS } from "./mcp/commands";
import type { McpMenuAction } from "./tui/mcp-menu";
import type { McpCatalogQuery } from "./mcp/catalog";
import { McpAuthManager } from "./mcp/auth";
import type { McpAuthAction } from "./tui/mcp-auth";
import { McpToolServer } from "./mcp/server";
import { InterceptedProvider, loadStreamRules, type StreamRule } from "./provider/interceptor";
import { subscribeLearnedLimits } from "./provider/limit-cache";
import { loadModelCatalogSync, refreshModelCatalog, type ModelCatalog } from "./provider/model-catalog";
import { primeRuntimeMetadata } from "./provider/runtime-metadata";
import { ProviderRouter, type LLMProvider } from "./provider/router";
import { ensureProjectState, resolveProjectState, type ProjectStatePaths } from "./runtime-paths";
import { formatBytes, runCleanup } from "./cache-cleanup";
import { cleanupRuntimeTempDir } from "./runtime-temp";
import { analyzeAndSplitCommits } from "./vcs/atomic-commit";
import { SnapshotManager, type RestoreResult } from "./vcs/snapshot";
import { runGit } from "./vcs/git";
import { WorktreeManager } from "./vcs/worktree";
import { formatElapsed, formatTokenCount } from "./tui/format";
import { TerminalRenderer } from "./tui/terminal-renderer";
import {
  installSynchronizedOutput,
  OrchivoxApp,
  interpretInput,
  type ChatEntryView,
  type InputAction,
  type ThinkingSegmentView,
} from "./tui/app";
import { applyCompactionMeter, applyContextEstimate, applyUsageContext, finishContextMeter } from "./tui/session-meter";
import { AUTO_DELEGATE_LABELS, type SettingsMode } from "./tui/settings-modal";
import { formatStatsReport } from "./tui/stats-report";
import { buildTranscriptEntries } from "./tui/transcript";
import { finalizeToolCalls } from "./tui/tool-state";
import {
  enterTerminal,
  installFatalHandlers,
  leaveTerminal,
  setTerminalTitle,
} from "./tui/terminal-protocol";
import type { FileAttachmentRef, PromptSubmitPayload } from "./tui/composer";
import { ApprovalQueue } from "./tui/approval-queue";
import type { PendingQuestion } from "./tui/question-modal";
import type { QuestionAnswer } from "./tools/question";
import type { HashlineLifecycle } from "./tools/hashline-edit";
import {
  AUTO_THEME,
  THEME_NAMES,
  isThemeName,
  isThemeSelection,
  normalizeThemeSelection,
  resolveThemeChoice,
  themeSelectionLabel,
  type TerminalAppearance,
  type ThemeSelection,
} from "./tui/theme";
import { detectTerminalAppearance } from "./tui/terminal-appearance";
import { basename, relative, join } from "node:path";
import { WorkspaceTrustManager } from "./security/workspace-trust";
import { WorkspaceTrustPrompt } from "./tui/trust-modal";
import type { ReasoningEffortLevel } from "./tui/command-palette";
import type { SessionModalTab } from "./tui/session-modal";
import {
  AgentModeSchema,
  type AgentMode,
  type CompactionReason,
  type Message,
} from "./types/schema";

export interface CliOptions {
  command: "tui" | "serve" | "prompt" | "mcp" | "update" | "doctor" | "clean";
  port?: number;
  prompt?: string;
  format: "text" | "json";
  mode: AgentMode;
  help: boolean;
  version?: boolean;
  updateCheck?: boolean;
  updateBinary?: boolean;
  updateYes?: boolean;
  updateRollback?: boolean;
  updateSource?: boolean;
  json?: boolean;
  cleanAll?: boolean;
  trust?: boolean;
  noAnim?: boolean;
  verbose?: boolean;
  configPath?: string;
  secretsPath?: string;
}

export interface RuntimeHandle {
  config: AppConfig;
  configPath: string;
  secretsPath: string;
  configSource: ConfigSource;
  secretsSource: ConfigSource;
  configExists: boolean;
  orchestrator: AgentOrchestrator;
  router: ProviderRouter;
  database: MemoryDatabase;
  snapshots: SnapshotManager;
  statePaths: ProjectStatePaths;
  plugins: { loaded: string[]; failed: Array<{ file: string; error: string }> };
  mcpServers: string[];
  mcpClient: McpClientManager;
  mcpReady?: Promise<McpConnectionReport>;
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
  "  orchivox update [--check] [--yes] [--rollback] [--source] [--json]",
  "                                       update the installed runtime or source checkout",
  "  orchivox self-update                 alias for orchivox update",
  "  orchivox doctor                      show entrypoint, install, config, and update diagnostics",
  "  orchivox clean [--all]               remove stale temp and cache files",
  "",
  "flags: -p/--prompt, -f/--format, --mode, --port, --trust, --all, -h/--help",
  "       --version                       print the version and commit",
  "       --no-anim                       disable installer animation",
  "       --verbose                       print installer diagnostics",
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
    else if (arg === "--yes") options.updateYes = true;
    else if (arg === "--rollback") options.updateRollback = true;
    else if (arg === "--source") options.updateSource = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--all") options.cleanAll = true;
    else if (arg === "--trust") options.trust = true;
    else if (arg === "--no-anim") options.noAnim = true;
    else if (arg === "--verbose") options.verbose = true;
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
    else if (arg === "update" || arg === "self-update") options.command = "update";
    else if (arg === "doctor") options.command = "doctor";
    else if (arg === "clean") options.command = "clean";
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
  // A worker worktree keeps its own history. Snapshotting it into the main
  // timeline would record an unrelated tree and confuse /undo and /timeline.
  const inWorkerWorkspace = (): boolean => currentTurnContext()?.workspaceRoot !== undefined;
  return {
    onBeforeModify: async (filePath) => {
      if (inWorkerWorkspace()) return;
      await deps.snapshots.captureSnapshot(`before edit ${filePath}`);
    },
    onAfterModify: async (filePath, newContent) => {
      if (inWorkerWorkspace()) return;
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
  options: { repoRoot?: string; configPath?: string; secretsPath?: string; waitForMcp?: boolean } = {},
): Promise<RuntimeHandle> {
  const root = options.repoRoot ?? globalThis.process.cwd();
  await runCleanup().catch(() => undefined);
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
  // One model pinned by every mode is the session model. Fold it into the main
  // role so a later model change applies everywhere instead of one mode.
  const sharedModel = sharedModeModel(config);
  if (sharedModel) {
    router.setRole("main", sharedModel.provider, sharedModel.model);
    router.clearModeModels();
    void (async () => {
      await saveRoleSelection(resolved.configPath, "main", sharedModel.provider, sharedModel.model);
      await clearModeModelSelections(resolved.configPath);
    })().catch(() => undefined);
  }
  void refreshModelCatalog(catalog).then(() => router.refresh()).catch(() => undefined);
  const unsubscribeLearned = subscribeLearnedLimits(() => router.refresh());
  const snapshots = new SnapshotManager({ repoRoot: root, stateDir: statePaths.snapshotsDir });
  const worktrees = new WorktreeManager({
    repoRoot: root,
    worktreesDir: statePaths.worktreesDir,
  });
  const lsp = await startLspClient(config, root);
  const lifecycle = buildHashEditLifecycle({ snapshots, lsp });
  const permissions = new GranularPermissionEngine({
    repoRoot: root,
    rules: resolvePermissionRules(config),
  });

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
    permissions,
  });
  const plugins = await orchestrator.initialize();
  const mcpClient = new McpClientManager({ registry: orchestrator.registry, skills: orchestrator.skills, auth: new McpAuthManager({ configPath: resolved.configPath }),
    lifecycle: config.mcp.lifecycle, scope: resolved.configPath, cacheDirectory: join(statePaths.dataDir, "mcp-catalog") });
  orchestrator.skills.setMcpServerStatus(() => Object.entries(config.mcp.servers).map(([name, server]) => ({
    name, enabled: server.enabled !== false, connected: mcpClient.listServers().includes(name),
    transport: server.transport, url: server.url,
    capabilities: mcpClient.capabilities(name),
  })));
  const mcpReady = mcpClient.connectAll(config.mcp.servers);
  if (options.waitForMcp !== false) await mcpReady;

  return {
    config,
    configPath: resolved.configPath,
    secretsPath: resolved.secretsPath,
    configSource: resolved.configSource,
    secretsSource: resolved.secretsSource,
    configExists: resolved.configExists,
    orchestrator,
    router,
    database,
    snapshots,
    statePaths,
    plugins,
    get mcpServers() { return mcpClient.listServers(); },
    mcpClient,
    mcpReady,
    close: async () => {
      unsubscribeLearned();
      await orchestrator.btw.close();
      orchestrator.closeSideTurns();
      await orchestrator.closeToolRuntimes();
      await orchestrator.stopAllWorkers();
      await orchestrator.bgProcesses.stopAll();
      await mcpClient.close();
      await lsp?.dispose();
      database.close();
      await cleanupRuntimeTempDir(root);
    },
  };
}

async function startLspClient(config: AppConfig, root: string): Promise<LSPClient | undefined> {
  const entry = Object.values(config.lsp.servers).find((server) => server.enabled !== false);
  if (!entry) return undefined;
  const client = new LSPClient({ command: entry.command, args: entry.args, env: entry.env, requestTimeoutMs: entry.request_timeout_ms });
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
    if (io.print) io.print(HELP_TEXT);
    else await writeStdout(HELP_TEXT);
    return { close: async () => undefined };
  }

  if (options.version) {
    const text = formatAppInfo(await getAppInfo());
    const versionFile = process.env.ORCHIVOX_VERSION_FILE;
    if (versionFile) {
      try {
        writeFileSync(versionFile, `${text}\n`, "utf8");
      } catch {
        // The installer falls back to stdout when the file cannot be written.
      }
    }
    if (io.print) io.print(text);
    else await writeStdout(text);
    return { close: async () => undefined };
  }

  if (options.command === "doctor") {
    print(await formatDoctor(process.cwd(), { checkUpdates: true }));
    return { close: async () => undefined };
  }

  if (options.command === "update") {
    const result = await runUpdate({
      check: options.updateCheck,
      binary: options.updateBinary,
      yes: options.updateYes,
      rollback: options.updateRollback,
      source: options.updateSource,
      json: options.json,
      noAnim: options.noAnim,
      verbose: options.verbose,
    });
    if (result.output) print(result.output);
    return { close: async () => undefined };
  }

  if (options.command === "clean") {
    const report = await runCleanup({
      aggressive: true,
      includeLegacyTestArtifacts: options.cleanAll,
    });
    const noun = report.removed === 1 ? "entry" : "entries";
    print(`cleanup removed ${report.removed} ${noun} and freed ${formatBytes(report.freedBytes)}`);
    return { close: async () => undefined };
  }

  if (options.command === "tui") {
    // Workspace trust is handled inside the single Orchivox TUI instance
    // to preserve process.stdin raw mode lifecycle and keyboard protocols.
  }

  // Ask the terminal for its background while the rest of the runtime boots.
  const appearancePromise: Promise<TerminalAppearance> =
    options.command === "tui" ? detectTerminalAppearance() : Promise.resolve("unknown");

  const runtime = await bootstrap({
    configPath: options.configPath,
    secretsPath: options.secretsPath,
    waitForMcp: options.command !== "tui",
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

  return runTuiSession(runtime, print, options, await appearancePromise);
}

async function runTuiSession(
  runtime: RuntimeHandle,
  print: (text: string) => void,
  options?: CliOptions,
  terminalAppearance: TerminalAppearance = "unknown",
): Promise<{ close: () => Promise<void> }> {
  const projectName = basename(globalThis.process.cwd());
  const root = globalThis.process.cwd();
  // Enter first, then push the keyboard flags. The composer must not push
  // again, otherwise the terminal keyboard stack is left dirty on exit.
  enterTerminal();
  const writeFatal = (chunk: string): void => {
    try {
      writeSync(1, chunk);
    } catch {
      // stdout may already be closed during a fatal error.
    }
  };
  const uninstallFatalHandlers = installFatalHandlers((error, signal) => {
    setTerminalTitle(projectName, writeFatal);
    leaveTerminal(writeFatal);
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    try {
      writeSync(2, `orchivox: ${signal}: ${detail}\n`);
    } catch {
      // stderr may already be closed during a fatal error.
    }
    globalThis.process.exit(1);
  });
  const stopFreezeMonitor = startEventLoopMonitor();

  setTerminalTitle(`Orchivox - ${projectName}`);
  const trustManager = new WorkspaceTrustManager();
  let isWorkspaceTrusted = Boolean(options?.trust || trustManager.isTrusted(root));
  const themeSelection = normalizeThemeSelection(runtime.config.theme);
  const themeChoice = resolveThemeChoice(themeSelection, terminalAppearance);

  const state = {
    sessionId: undefined as string | undefined,
    sessionEpoch: 0,
    entries: [] as ChatEntryView[],
    messages: [] as Message[],
    mode: runtime.config.active_mode as AgentMode,
    autoDelegate: runtime.config.orchestration.auto_delegate as AutoDelegateMode,
    currentTheme: themeChoice.theme,
    themeSelection: themeChoice.selection,
    terminalAppearance,
    reasoningEffort: "default" as ReasoningEffortLevel,
    reasoningByMode: {
      plan: "default",
      build: "low",
      ultrawork: "default",
    } as Record<AgentMode, ReasoningEffortLevel>,
    streamingText: "",
    liveEntry: undefined as ChatEntryView | undefined,
    modifiedFiles: new Map<string, { path: string; additions: number; deletions: number }>(),
    totalTokens: 0,
    contextTokens: 0,
    contextSource: "estimated" as "estimated" | "reported",
    contextRequestBytes: 0,
    contextInputBudget: 0,
    contextBufferTokens: 0,
    maxRequestBytes: runtime.config.limits.max_request_bytes,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCostUsd: 0,
    costIncomplete: false,
    lastPromptTokens: 0,
    lastCompletionTokens: 0,
    lastTotalTokens: 0,
    lastEstimatedPromptTokens: 0,
    turnPromptTokens: 0,
    turnCompletionTokens: 0,
    turnTotalTokens: 0,
    turnRequests: 0,
    tokenBudgetWarned: false,
    lastOutcome: undefined as string | undefined,
    busy: false,
    counter: 0,
    helpOpen: false,
    modelsOpen: false,
    modelsView: "models" as "models" | "providers",
    skillsOpen: false,
    settingsOpen: false,
    skills: runtime.orchestrator.skills.listDocuments() as SkillDocument[],
    skillDiagnostics: runtime.orchestrator.skills.listDiagnostics(),
    skillDependencies: [] as SkillDependencyReport[],
    activeSkills: [] as string[],
    hubTab: "workers" as "workers" | "tasks",
    paletteOpen: false,
    sessionTab: null as SessionModalTab | null,
    hubOpen: false,
    report: undefined as { title: string; text: string } | undefined,
    notice: undefined as string | undefined,
    updateNotice: undefined as string | undefined,
    mcpChanging: false,
    mcpOpen: false,
    mcpAuthServer: undefined as string | undefined,
  };
  const refreshSkillDiagnostics = (): void => {
    state.skills = runtime.orchestrator.skills.listDocuments();
    state.skillDependencies = runtime.orchestrator.skills.inspectDependencies({ mode: state.mode });
    state.skillDiagnostics = [...runtime.orchestrator.skills.listDiagnostics(), ...dependencyDiagnostics(state.skillDependencies)];
  };
  const resetUsageDetails = (): void => {
    state.lastPromptTokens = 0;
    state.lastCompletionTokens = 0;
    state.lastTotalTokens = 0;
    state.lastEstimatedPromptTokens = 0;
    state.turnPromptTokens = 0;
    state.turnCompletionTokens = 0;
    state.turnTotalTokens = 0;
    state.turnRequests = 0;
    state.tokenBudgetWarned = false;
    state.lastOutcome = undefined;
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
  let cancelBackgroundView = (): void => undefined;
  const setActiveMode = (next: AgentMode): void => {
    const changed = state.mode !== next;
    state.mode = next;
    state.reasoningEffort = normalizeReasoningForMode(next, state.reasoningByMode[next]);
    if (changed) {
      cancelBackgroundView();
      if (state.skillsOpen) refreshSkillDiagnostics();
      state.contextTokens = estimateContextTokens(next, state.messages);
      state.contextSource = "estimated";
      runtime.config.active_mode = next;
      void saveActiveMode(runtime.configPath, next).catch((error) => {
        setNotice(
          `Could not save mode: ${error instanceof Error ? error.message : String(error)}`,
          6000,
        );
      });
    }
  };
  const estimateContextTokens = (mode: AgentMode, messages: Message[]): number => {
    const overhead = runtime.orchestrator.estimateContextOverhead(mode);
    return overhead + messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  };
  let relay: CollabRelay | undefined;
  let branch = "unknown";
  const approvals = new ApprovalQueue();
  let pendingQuestion: PendingQuestion | undefined;
  let questionResolver: ((answer: QuestionAnswer) => void) | undefined;
  let activeAbortController: AbortController | undefined;
  let shuttingDown = false;

  runtime.orchestrator.permissions.setApprovalHandler((request) => {
    const decision = approvals.enqueue(request);
    rerender();
    return decision;
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

  let pendingCompactionEntryId: string | undefined;

  const beginCompaction = (
    reason: CompactionReason,
    attempt?: number,
    maxAttempts?: number,
  ): string => {
    state.counter += 1;
    const id = `entry-${state.counter}`;
    state.entries = [
      ...state.entries,
      {
        id,
        role: "compaction",
        text: "",
        compaction: {
          beforeTokens: state.contextTokens,
          afterTokens: state.contextTokens,
          removedMessages: 0,
          auto: reason !== "manual",
          reason,
          status: "running",
          attempt,
          maxAttempts,
        },
      },
    ];
    pendingCompactionEntryId = id;
    return id;
  };

  const finishCompaction = (compaction: {
    summary?: string;
    beforeTokens: number;
    afterTokens: number;
    removedMessages: number;
    auto?: boolean;
    reason?: CompactionReason;
    trigger?: "tokens" | "request_size" | "overflow" | "output_limit" | "manual";
    requestBytes?: number;
    maxRequestBytes?: number;
    inputBudget?: number;
    bufferTokens?: number;
    status?: "running" | "done" | "error";
    error?: string;
    attempt?: number;
    maxAttempts?: number;
  }): void => {
    const id = pendingCompactionEntryId;
    pendingCompactionEntryId = undefined;
    if (id) {
      state.entries = state.entries.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              text: compaction.summary ?? "",
              compaction: {
                beforeTokens: compaction.beforeTokens,
                afterTokens: compaction.afterTokens,
                removedMessages: compaction.removedMessages,
                auto: compaction.auto,
                reason: compaction.reason,
                trigger: compaction.trigger,
                requestBytes: compaction.requestBytes,
                maxRequestBytes: compaction.maxRequestBytes,
                inputBudget: compaction.inputBudget,
                bufferTokens: compaction.bufferTokens,
                status: compaction.status ?? "done",
                error: compaction.error,
                attempt: compaction.attempt,
                maxAttempts: compaction.maxAttempts,
              },
            }
          : entry,
      );
      return;
    }
    pushEntry("compaction", compaction.summary ?? "", {
      compaction: {
        beforeTokens: compaction.beforeTokens,
        afterTokens: compaction.afterTokens,
        removedMessages: compaction.removedMessages,
        auto: compaction.auto,
        reason: compaction.reason,
        trigger: compaction.trigger,
        requestBytes: compaction.requestBytes,
        maxRequestBytes: compaction.maxRequestBytes,
        inputBudget: compaction.inputBudget,
        bufferTokens: compaction.bufferTokens,
        status: compaction.status ?? "done",
        error: compaction.error,
        attempt: compaction.attempt,
        maxAttempts: compaction.maxAttempts,
      },
    });
  };

  const cancelCompaction = (): void => {
    const id = pendingCompactionEntryId;
    pendingCompactionEntryId = undefined;
    if (!id) return;
    state.entries = state.entries.filter((entry) => entry.id !== id);
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
    setTerminalTitle(session.title);
    return session.id;
  };

  let hasComposerDraft = false;
  let hasOpenInteraction = false;
  const backgroundJobs = new SessionBackgroundJobs({
    config: () => runtime.config.background,
    view: () => ({
      sessionId: state.sessionId, busy: state.busy || inputQueue.active || inputQueue.size > 0, draft: hasComposerDraft,
      blocked: hasOpenInteraction || state.helpOpen || state.modelsOpen || state.skillsOpen || state.settingsOpen || state.paletteOpen || state.hubOpen || state.sessionTab !== null || Boolean(state.report) || Boolean(approvals.current()) || Boolean(pendingQuestion),
      workers: runtime.orchestrator.subagents.listWorkers().some((worker) => worker.parentSessionId === state.sessionId && ["queued", "preparing", "running", "finalizing"].includes(worker.status)),
    }),
    store: runtime.database,
    run: (input) => runtime.orchestrator.runSideTurn(input),
    onTitle: (sessionId, title) => {
      if (state.sessionId !== sessionId) return;
      setTerminalTitle(title);
      refreshSessionUsage();
      rerender();
    },
    onRecap: (sessionId, text) => {
      if (state.sessionId !== sessionId) return;
      state.entries = state.entries.filter((entry) => !entry.id.startsWith("recap-"));
      state.entries.push({ id: `recap-${sessionId}`, role: "system", kind: "recap", text: `Recap: ${text}` });
      refreshSessionUsage();
      rerender();
    },
  });
  cancelBackgroundView = () => {
    backgroundJobs.invalidate();
    if (state.sessionId) runtime.orchestrator.cancelSideTurns(state.sessionId);
  };
  const maybeGenerateSessionTitle = (sessionId: string): void => {
    const session = runtime.database.getSession(sessionId);
    const firstUser = state.messages.find((message) => message.role === "user" && message.metadata?.synthetic !== true && messageText(message));
    if (!session || !firstUser) return;
    if (session.title !== sessionTitle(messageText(firstUser)) && !isPlaceholderTitle(session.title)) return;
    void backgroundJobs.ensureTitle(sessionId, session.title);
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

  /**
   * Worker usage is persisted by the orchestrator. Reading the session back
   * keeps the header cost and /stats accurate without double counting.
   */
  const refreshSessionUsage = (): void => {
    if (!state.sessionId) return;
    try {
      const session = runtime.database.getSession(state.sessionId);
      if (!session) return;
      state.totalTokens = session.totalTokens;
      state.totalCostUsd = session.totalCostUsd;
      state.costIncomplete = session.costIncomplete ?? session.totalTokens > 0;
    } catch {
      // Usage refresh is best effort.
    }
  };

  /** Drop approvals whose worker already stopped, including stops started by a tool. */
  const pruneStoppedApprovals = (): void => {
    for (const request of approvals.pendingRequests()) {
      if (!request.workerId) continue;
      const worker = runtime.orchestrator.subagents.getWorker(request.workerId);
      if (
        !worker ||
        worker.status === "completed" ||
        worker.status === "failed" ||
        worker.status === "aborted" ||
        worker.status === "timed_out"
      ) {
        approvals.cancelForWorker(request.workerId, "worker stopped");
      }
    }
  };

  const applyThemeSelection = (next: ThemeSelection): void => {
    const choice = resolveThemeChoice(next, state.terminalAppearance);
    if (choice.warning) { setNotice(`Cannot apply ${next} on a ${state.terminalAppearance} terminal. Current theme kept.`, 9000); return; }
    state.themeSelection = choice.selection;
    state.currentTheme = choice.theme;
    if (choice.selection === next) {
      void saveTheme(runtime.configPath, next).catch((error) => {
        setNotice(
          `Could not save theme: ${error instanceof Error ? error.message : String(error)}`,
          6000,
        );
      });
    }
    const label = themeSelectionLabel(choice.selection, choice.theme);
    setNotice(choice.warning ? `${label}. ${choice.warning}` : `Theme: ${label}`, choice.warning ? 9000 : 6000);
  };

  const warnedLargeSessions = new Set<string>();
  const warnLargeSession = (
    sessionId: string,
    totalTokens: number | undefined,
    messages: Message[],
  ): void => {
    if (warnedLargeSessions.has(sessionId)) return;
    const historyBytes = estimateRequestBytes({ messages });
    const warn = shouldWarnLargeSession({
      totalTokens,
      historyBytes,
      warnTokens: runtime.config.limits?.session_warn_tokens,
      warnBytes: runtime.config.limits?.session_warn_bytes,
    });
    if (!warn) return;
    warnedLargeSessions.add(sessionId);
    const size = [
      formatTokenCount(totalTokens ?? 0),
      `${Math.round(historyBytes / 1024)} KB of history`,
    ].join(" tokens, ");
    pushEntry(
      "system",
      `This session is large (${size}). Run /compact or /new before continuing.`,
    );
    setNotice("Large session: run /compact or /new before continuing.", 12_000);
  };

  if (!runtime.configExists) {
    state.notice = "No config found. Use /connect to add a provider.";
  } else if (!isThemeSelection(runtime.config.theme)) {
    state.notice = `Unknown theme "${runtime.config.theme}". Using ${themeSelectionLabel(state.themeSelection, state.currentTheme)}.`;
  } else if (themeChoice.warning) {
    state.notice = themeChoice.warning;
  }

  let btwOpen = false;
  let btwTurns: BtwTurn[] = [];
  let btwTopicId: string | undefined;
  let queueOpen = false;
  let queueEdit: QueueMessage | undefined;
  const queueOperation = <T>(operation: () => T): T | undefined => {
    try { return operation(); }
    catch (error) {
      setNotice(`Could not update the queue: ${error instanceof Error ? error.message : String(error)}`, 8000);
      rerender();
      return undefined;
    }
  };
  const openQueue = (): void => {
    queueOperation(() => {
      inputQueue.refresh();
      queueOpen = true;
      btwOpen = false;
      rerender();
    });
  };
  const leaveBtwSession = (): void => {
    if (state.sessionId) runtime.orchestrator.btw.cancel(state.sessionId);
    btwOpen = false;
    btwTurns = [];
    btwTopicId = undefined;
  };
  const openBtw = (): void => {
    btwTurns = state.sessionId ? runtime.orchestrator.btw.history(state.sessionId) : [];
    btwTopicId = btwTurns.at(-1)?.topicId;
    btwOpen = true;
    rerender();
  };
  const sendBtw = (question: string, topicId?: string, attachments?: FileAttachmentRef[]): boolean => {
    if (attachments?.some((attachment) => attachment.error)) {
      setNotice("A side-question attachment could not be loaded. Fix it before sending.", 8000);
      rerender();
      return false;
    }
    const sessionId = ensureSession("Interactive Session");
    const images = (attachments ?? []).filter((attachment) => attachment.kind === "image" && attachment.base64 && attachment.mimeType)
      .map((attachment) => ({ type: "image" as const, path: attachment.filePath,
        source: { type: "base64" as const, media_type: attachment.mimeType!, data: attachment.base64! } }));
    const result = runtime.orchestrator.btw.start({ sessionId, question, topicId, images,
      activity: JSON.stringify({ mainBusy: state.busy || inputQueue.active,
        visibleNarration: state.liveEntry?.thinkingSegments?.filter((segment) => segment.kind === "text").map((segment) => segment.text),
        visibleAnswer: state.liveEntry?.text,
        tools: state.liveEntry?.toolCalls?.map((call) => ({ name: call.name, status: call.status, output: call.output })),
      }),
    });
    if (!result.accepted) {
      setNotice(result.error ?? "Could not start the side question.", 8000);
      rerender();
      return false;
    }
    btwTurns = runtime.orchestrator.btw.history(sessionId);
    btwTopicId = result.topicId;
    btwOpen = true;
    rerender();
    return true;
  };
  const inputRouter = new InputRouter<FileAttachmentRef>({
    store: runtime.database.inputQueueStore<SubmittedInput<FileAttachmentRef>>(),
    sessionId: () => ensureSession("Interactive Session"),
    blocked: () => state.busy || state.mcpChanging,
    run: async ({ text, action, attachments, agent, task, context }, item, run) => {
      run.assertCurrent();
      if (item.sessionId !== state.sessionId) throw new InputRunCancelled("interrupted");
      const lease = new SessionViewLease({ id: item.sessionId, epoch: state.sessionEpoch },
        () => ({ id: state.sessionId, epoch: state.sessionEpoch, closed: shuttingDown }), run);
      return lease.run(async () => {
        if (action.kind === "command") {
          return handleCommand(action.command, action.args ?? "", action.raw ?? text, attachments, text, item.sessionId, run);
        }
        if (action.ultrawork) setActiveMode("ultrawork");
        return executeTurn(text, undefined, agent, attachments, { task, context, run });
      }, () => {
        state.busy = false;
        state.liveEntry = undefined;
        state.streamingText = "";
        activeAbortController = undefined;
        cancelCompaction();
      });
    },
    control: async ({ text, action }) => {
      if (action.kind === "command") {
        await handleCommand(action.command, action.args ?? "", action.raw ?? text);
      }
    },
    side: ({ text, action, attachments }) => {
      if (action.kind !== "command") return false;
      if (!(action.args ?? "").trim()) { openBtw(); return true; }
      const raw = action.raw ?? text;
      const context = text.startsWith(raw) ? text.slice(raw.length) : "";
      return sendBtw(`${action.args}${context}`, undefined, attachments);
    },
    onQueued: (position) => {
      setNotice(`Queued #${position}. Uses the mode and model active when it starts.`, 6000);
    },
    onError: (error) => {
      pushEntry("system", `input failed: ${error instanceof Error ? error.message : String(error)}`);
    },
    onChange: () => rerender(),
  });
  const inputQueue = inputRouter.work;
  const executeMcpCommand = async (args: string, signal?: AbortSignal): Promise<string> => {
    const action = args.trim().split(/\s+/, 1)[0];
    const changes = MCP_CONNECTION_ACTIONS.has(action) || action === "skill";
    if (changes && state.mcpChanging) throw new Error("MCP connections are already being updated.");
    if (changes) { state.mcpChanging = true; rerender(); }
    try {
      return await mcpCommand(args, { manager: runtime.mcpClient, servers: runtime.config.mcp.servers, configPath: runtime.configPath, mode: state.mode, root: process.cwd(), signal,
        busy: state.busy || inputQueue.active || runtime.orchestrator.subagents.listWorkers().some((worker) => ["queued", "preparing", "running", "finalizing"].includes(worker.status)) || btwTurns.some((turn) => turn.status === "running") });
    } finally {
      if (changes) { state.mcpChanging = false; void inputQueue.drain(); }
      refreshSkillDiagnostics();
      if (!shuttingDown) rerender();
    }
  };

  const resetToWelcome = (): void => {
    cancelCompaction();
    queueEdit = undefined;
    queueOpen = false;
    leaveBtwSession();
    cancelBackgroundView();
    inputQueue.clear();
    state.sessionId = undefined;
    state.sessionEpoch += 1;
    inputQueue.switchSession(`draft-${state.sessionEpoch}`);
    state.entries = [];
    state.messages = [];
    state.liveEntry = undefined;
    state.streamingText = "";
    state.activeSkills = [];
    state.contextTokens = 0;
    state.contextSource = "estimated";
    state.contextRequestBytes = 0;
    state.contextInputBudget = 0;
    state.contextBufferTokens = 0;
    state.maxRequestBytes = runtime.config.limits.max_request_bytes;
    state.totalTokens = 0;
    state.totalPromptTokens = 0;
    state.totalCompletionTokens = 0;
    state.totalCostUsd = 0;
    state.costIncomplete = false;
    resetUsageDetails();
    state.modifiedFiles.clear();
    state.counter = 0;
    state.report = undefined;
    state.busy = false;
  };

  const reloadSkills = async (): Promise<void> => {
    state.skills = await runtime.orchestrator.skills.load(true);
    refreshSkillDiagnostics();
    resetSkillAutocompleteCache();
    rerender();
  };

  const abortMainTurn = (): void => {
    const cancelled = inputQueue.cancelActive();
    cancelBackgroundView();
    if (questionResolver) {
      const resolve = questionResolver;
      questionResolver = undefined;
      pendingQuestion = undefined;
      resolve({ selected: [], cancelled: true });
    }
    approvals.cancelAll("Cancelled by user.");
    if (activeAbortController || cancelled) {
      activeAbortController?.abort();
      pushEntry("system", "process cancelled by user.");
      rerender();
    }
  };
  const staleQueueNotice = (): void => setNotice("This message is already processing or is no longer queued. Its active prompt was not changed.", 8000);
  const discardQueueEdit = (): boolean => queueOperation(() => {
    if (queueEdit?.editToken) inputQueue.cancelEdit(queueEdit.id, queueEdit.editToken);
    queueEdit = undefined;
    rerender();
    return true;
  }) ?? false;
  const captureView = (): SessionViewLease => new SessionViewLease({ id: state.sessionId, epoch: state.sessionEpoch },
    () => ({ id: state.sessionId, epoch: state.sessionEpoch, closed: shuttingDown }));
  const view = () => {
    const viewLease = captureView();
    return ({
    queuedCount: inputQueue.size,
    queuePaused: inputQueue.paused,
    queuePauseDetail: inputQueue.pauseDetail,
    queue: queueOpen ? { items: inputQueue.items, editing: queueEdit, paused: inputQueue.paused,
      pauseReason: inputQueue.pauseReason, pauseDetail: inputQueue.pauseDetail, stoppingId: inputQueue.stopping ? inputQueue.runningItem?.id : undefined,
      canStopId: !inputQueue.stopping ? inputQueue.runningItem?.id : undefined } : undefined,
    onQueueOpen: openQueue,
    onQueueEdit: (id: string) => queueOperation(() => {
      const item = inputQueue.beginEdit(id);
      if (item) queueEdit = item;
      else staleQueueNotice();
      rerender();
    }),
    onQueueSave: (payload: PromptSubmitPayload) => queueOperation(() => {
      if (!viewLease.isCurrent()) return false;
      const action = interpretInput(payload.rawText);
      if (inputRoute(action) !== "work") {
        setNotice("Send UI commands and /btw from the main input. A queued edit must remain a work request.", 8000);
        rerender();
        return false;
      }
      if (!queueEdit?.editToken) return false;
      const input = { ...queueEdit.input, text: payload.fullText, action, attachments: payload.attachments };
      const saved = inputQueue.saveEdit(queueEdit.id, queueEdit.editToken, input);
      if (saved) queueEdit = undefined;
      else staleQueueNotice();
      rerender();
      return saved;
    }) ?? false,
    onQueueDiscard: discardQueueEdit,
    onQueueCancel: (id: string) => queueOperation(() => {
      if (!inputQueue.cancel(id)) staleQueueNotice();
      else if (queueEdit?.id === id) queueEdit = undefined;
      rerender();
    }),
    onQueueResume: () => queueOperation(() => {
      if (!inputQueue.resume()) setNotice("Wait for the active request to stop before resuming the queue.", 8000);
    }),
    onQueueStop: (id: string) => { if (inputQueue.runningItem?.id === id) abortMainTurn(); else staleQueueNotice(); },
    onQueueClose: () => { if (discardQueueEdit()) { queueOpen = false; rerender(); } },
    btw: btwOpen ? { turns: btwTurns, topicId: btwTopicId } : undefined,
    btwRunning: btwTurns.some((turn) => turn.status === "running"),
    onBtwSelect: (topicId: string) => { btwTopicId = topicId; rerender(); },
    onBtwFollowup: (topicId: string, question: string, attachments?: FileAttachmentRef[]) => viewLease.isCurrent() && sendBtw(question, topicId, attachments),
    onBtwCancel: () => { if (state.sessionId) runtime.orchestrator.btw.cancel(state.sessionId); },
    onBtwClose: () => { btwOpen = false; rerender(); },
    frameClock: terminalRenderer.clock,
    projectName,
    branch,
    mcpCount: runtime.mcpServers.length,
    pluginCount: runtime.plugins.loaded.length,
    totalTokens: state.totalTokens,
    contextTokens: state.contextTokens,
    contextRequestLabel:
      state.contextRequestBytes > 0 ? formatBytes(state.contextRequestBytes) : undefined,
    maxRequestLabel: state.maxRequestBytes > 0 ? formatBytes(state.maxRequestBytes) : undefined,
    totalCostUsd: state.totalCostUsd,
    costIncomplete: state.costIncomplete,
    contextSource: state.contextSource,
    entries: state.entries,
    streamingText: state.streamingText,
    liveEntry: state.liveEntry,
    busy: state.busy || inputQueue.active,
    mode: state.mode,
    workers: runtime.orchestrator.subagents.listWorkers(),
    router: runtime.router,
    database: runtime.database,
    snapshots: runtime.snapshots,
    activeSessionId: state.sessionId ?? `draft-${state.sessionEpoch}`,
    activeSessionMessages: state.messages,
    currentTheme: state.currentTheme,
    themeSelection: state.themeSelection,
    updateNotice: state.updateNotice,
    terminalAppearance: state.terminalAppearance,
    statusMessage: state.notice,
    onStatusMessage: setNotice,
    helpOpen: state.helpOpen,
    onHelpOpenChange: (open: boolean) => {
      state.helpOpen = open;
      rerender();
    },
    report: state.report,
    mcpMenu: state.mcpOpen ? { changing: state.mcpChanging, authServer: state.mcpAuthServer, servers: Object.entries(runtime.config.mcp.servers).map(([name, config]) => ({
      name, transport: config.transport, command: config.command, args: config.args, url: config.url, enabled: config.enabled,
      status: !config.enabled ? "disabled" as const : runtime.mcpClient.status(name).phase,
      tools: runtime.mcpClient.toolNames(name),
      cachedTools: runtime.mcpClient.status(name).cachedTools,
      stale: runtime.mcpClient.status(name).stale,
      catalogRevision: runtime.mcpClient.status(name).revision,
      capabilities: runtime.mcpClient.listServers().includes(name) ? runtime.mcpClient.capabilities(name) : runtime.mcpClient.status(name).cachedCapabilities,
      auth: runtime.mcpClient.authStatus(name, config),
      error: runtime.mcpClient.failure(name) ? runtime.mcpClient.listServers().includes(name) ? "Catalog refresh failed. Reconnect to refresh." : "Connection failed. Check server availability and credentials." : undefined,
    })), onBrowse: (query: McpCatalogQuery, signal: AbortSignal) => mcpCatalogView(query, { manager: runtime.mcpClient, mode: state.mode, root: process.cwd(), signal }),
      onSelectSkill: (server: string, uri: string, signal: AbortSignal) => executeMcpCommand(`skill ${server} ${uri}`, signal),
      onAuthenticate: (server: string, action: McpAuthAction, storage?: "native" | "session", signal?: AbortSignal) => executeMcpCommand([action, server, storage].filter(Boolean).join(" "), signal) } : undefined,
    onMcpClose: () => { state.mcpOpen = false; state.mcpAuthServer = undefined; rerender(); },
    onMcpAction: async (action: McpMenuAction) => {
      const args = [action.kind, action.name, action.config ? JSON.stringify(action.config) : undefined].filter(Boolean).join(" ");
      await executeMcpCommand(args);
    },
    onReportClose: () => {
      state.report = undefined;
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
    skillDiagnostics: state.skillDiagnostics,
    skillDependencies: state.skillDependencies,
    activeSkills: state.activeSkills,
    onSkillsOpenChange: (open: boolean) => {
      if (open) refreshSkillDiagnostics();
      state.skillsOpen = open;
      rerender();
    },
    onReloadSkills: () => {
      void reloadSkills();
    },
    settingsOpen: state.settingsOpen,
    onSettingsOpenChange: (open: boolean) => {
      state.settingsOpen = open;
      rerender();
    },
    approvalsPreset: runtime.config.approvals.preset ?? "safer",
    autoDelegate: state.autoDelegate,
    animations: runtime.config.ui.animations,
    memoryEnabled: runtime.config.memory.enabled,
    onMemoryEnabledChange: (enabled: boolean) => {
      runtime.config.memory.enabled = enabled;
      void saveMemoryEnabled(runtime.configPath, enabled).catch((error) => {
        setNotice(`Could not save memory setting: ${error instanceof Error ? error.message : String(error)}`, 8000);
      });
      setNotice(`Long-term memory: ${enabled ? "On" : "Off"}. Saved notes are kept.`, 6000);
      rerender();
    },
    workerTimeoutSeconds: runtime.config.orchestration.worker_timeout_seconds,
    onWorkerTimeoutChange: (seconds: number) => {
      runtime.config.orchestration.worker_timeout_seconds = seconds;
      void saveWorkerTimeout(runtime.configPath, seconds).catch((error) => {
        setNotice(`Could not save worker time limit: ${error instanceof Error ? error.message : String(error)}`, 8000);
      });
      rerender();
    },
    workerFallback: runtime.config.orchestration.worker_fallback,
    onWorkerFallbackChange: (value: WorkerFallbackMode) => {
      runtime.config.orchestration.worker_fallback = value;
      void saveWorkerFallback(runtime.configPath, value).catch((error) => {
        setNotice(`Could not save worker fallback: ${error instanceof Error ? error.message : String(error)}`, 8000);
      });
      rerender();
    },
    onAnimationsChange: (enabled: boolean) => {
      runtime.config.ui.animations = enabled;
      void saveAnimations(runtime.configPath, enabled).catch((error) => {
        setNotice(`Could not save animations: ${error instanceof Error ? error.message : String(error)}`, 8000);
      });
      rerender();
    },
    modeSteps: {
      plan: runtime.config.modes.plan.steps ?? 0,
      build: runtime.config.modes.build.steps ?? 0,
      ultrawork: runtime.config.modes.ultrawork.steps ?? 0,
    },
    configSource: runtime.configSource,
    onApprovalsPresetChange: (preset: ApprovalPreset) => {
      runtime.config.approvals.preset = preset;
      runtime.orchestrator.permissions.setRules(resolvePermissionRules(runtime.config));
      void saveApprovalsPreset(runtime.configPath, preset).catch((error) => {
        setNotice(`could not save approval preset: ${error instanceof Error ? error.message : String(error)}`, 8000);
      });
      setNotice(`Approval preset: ${preset}`, 6000);
      rerender();
    },
    onAutoDelegateChange: (mode: AutoDelegateMode) => {
      state.autoDelegate = mode;
      runtime.config.orchestration.auto_delegate = mode;
      void saveAutoDelegate(runtime.configPath, mode).catch((error) => {
        setNotice(`could not save auto coordinator: ${error instanceof Error ? error.message : String(error)}`, 8000);
      });
      setNotice(`Coordinator: ${AUTO_DELEGATE_LABELS[mode]}`, 6000);
      rerender();
    },
    background: runtime.config.background,
    limits: runtime.config.limits,
    onLimitsChange: (patch: Partial<LimitsConfig>) => {
      runtime.config.limits = { ...runtime.config.limits, ...patch };
      void saveTurnLimits(runtime.configPath, patch).catch((error) => setNotice(`Could not save turn limits: ${error instanceof Error ? error.message : String(error)}`, 8000));
      setNotice("Turn limits updated for the next message.", 6000);
      rerender();
    },
    delegation: runtime.config.orchestration.delegation,
    onDelegationChange: (value: DelegationPolicy) => {
      runtime.config.orchestration.delegation = value;
      void saveDelegationPolicy(runtime.configPath, value).catch((error) => setNotice(`Could not save delegation: ${error instanceof Error ? error.message : String(error)}`, 8000));
      setNotice(`Delegation: ${value}. Applies to the next message.`, 6000);
      rerender();
    },
    onBackgroundChange: (patch: Partial<BackgroundConfig>) => {
      runtime.config.background = { ...runtime.config.background, ...patch };
      cancelBackgroundView();
      void saveBackground(runtime.configPath, patch).catch((error) => setNotice(`Could not save background settings: ${error instanceof Error ? error.message : String(error)}`, 8000));
      rerender();
    },
    onModeStepsChange: (mode: SettingsMode, steps: number) => {
      runtime.config.modes[mode].steps = steps;
      void saveModeSteps(runtime.configPath, mode, steps).catch((error) => {
        setNotice(`could not save ${mode} steps: ${error instanceof Error ? error.message : String(error)}`, 8000);
      });
      setNotice(
        `${mode} steps: ${steps === 0 ? "unlimited" : String(steps)}`,
        6000,
      );
      rerender();
    },
    tasks: runtime.orchestrator.tasks.list(),
    hubTab: state.hubTab,
    onHubTabChange: (tab: "workers" | "tasks") => {
      state.hubTab = tab;
      rerender();
    },
    onCancelTask: (id: string) => {
      const task = runtime.orchestrator.tasks.get(id);
      if (task?.workerId) {
        approvals.cancelForWorker(task.workerId, "task cancelled");
        void runtime.orchestrator.stopWorker(task.workerId);
      }
      runtime.orchestrator.tasks.cancel(id);
      refreshSessionUsage();
      rerender();
    },
    onDispatchTasks: () => {
      runtime.orchestrator.tasks.dispatch();
      rerender();
    },
    onMergeTask: (id: string) => {
      setNotice(`merging ${id}...`, 10000);
      void runtime.orchestrator.tasks.merge(id).then((message) => {
        if (!viewLease.isCurrent()) return;
        setNotice(message, 12000);
      });
    },
    configPath: runtime.configPath,
    secretsPath: runtime.secretsPath,
    onRoleChange: (role: "main" | "fast" | "advisor", provider: string, model: string) => {
      normalizeAllReasoning();
      setNotice(`${role} now uses ${provider} / ${model}`);
    },
    onSessionModelChange: (provider: string, model: string) => {
      normalizeAllReasoning();
      state.contextTokens = estimateContextTokens(state.mode, state.messages);
      state.contextSource = "estimated";
      setNotice(`all modes now use ${provider} / ${model}`, 6000);
      rerender();
    },
    onModeModelChange: (mode: ConfigMode, provider: string, model: string) => {
      runtime.router.setModeModel(mode, provider, model);
      state.reasoningByMode[mode] = normalizeReasoningForMode(mode, state.reasoningByMode[mode]);
      if (state.mode === mode) state.reasoningEffort = state.reasoningByMode[mode];
      if (state.mode === mode) {
        state.contextTokens = estimateContextTokens(state.mode, state.messages);
        state.contextSource = "estimated";
      }
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
    onThemeChange: (nextTheme: ThemeSelection) => {
      applyThemeSelection(nextTheme);
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
      if (state.busy || inputQueue.active) {
        setNotice("Cancel the running turn before switching sessions.", 8000);
        return;
      }
      leaveBtwSession();
      cancelBackgroundView();
      state.sessionId = sessionId;
      state.sessionEpoch += 1;
      queueEdit = undefined;
      queueOpen = false;
      inputQueue.switchSession(sessionId);
      state.liveEntry = undefined;
      state.modifiedFiles.clear();
      const msgs = runtime.database.loadMessages(sessionId);
      const history = runtime.database.loadFullMessages(sessionId);
      state.messages = msgs;
      const invokedSkills = new Set(runtime.database.listSessionSkillLoads(sessionId).filter((load) => load.invoked).map(skillSourceKey));
      state.activeSkills = visibleSkillLoads(msgs, runtime.orchestrator.skills.listDocuments().filter(skillEnabled)).filter((load) => {
        const document = runtime.orchestrator.skills.get(load.id);
        return document && (!(document.autoinvoke === false || document.hidden) || load.invoked || invokedSkills.has(skillSourceKey(load)));
      }).map((load) => load.id);
      state.entries = buildTranscriptEntries(history, runtime.database.getCompaction(sessionId));
      const recap = runtime.database.getRecap(sessionId);
      if (recap) state.entries.push({ id: `recap-${sessionId}`, role: "system", kind: "recap", text: `Recap: ${recap.text}` });
      state.counter = state.entries.length;
      const sess = runtime.database.getSession(sessionId);
      if (sess) setActiveMode(sess.mode);
      setTerminalTitle(sess?.title ?? `Orchivox - ${projectName}`);
      state.contextTokens = estimateContextTokens(state.mode, state.messages);
      state.contextRequestBytes = 0;
      state.contextInputBudget = 0;
      state.contextBufferTokens = 0;
      warnLargeSession(sessionId, sess?.totalTokens, msgs);
      state.totalTokens = sess?.totalTokens ?? 0;
      state.totalCostUsd = sess?.totalCostUsd ?? 0;
      state.costIncomplete = sess?.costIncomplete ?? (sess?.totalTokens ?? 0) > 0;
      state.contextSource = "estimated";
      state.totalPromptTokens = 0;
      state.totalCompletionTokens = 0;
      resetUsageDetails();
      pushEntry("system", `resumed session: ${sess?.title ?? sessionId}`);
      rerender();
    },
    onNewSession: () => {
      void handleCommand("/new");
    },
    onForkSession: (forked: SessionRecord) => {
      if (state.busy || inputQueue.active) {
        setNotice("Cancel the running turn before forking the session.", 8000);
        return;
      }
      leaveBtwSession();
      cancelBackgroundView();
      state.sessionId = forked.id;
      state.sessionEpoch += 1;
      queueEdit = undefined;
      queueOpen = false;
      inputQueue.switchSession(forked.id);
      setTerminalTitle(forked.title);
      setActiveMode(forked.mode);
      state.liveEntry = undefined;
      state.modifiedFiles.clear();
      state.totalTokens = forked.totalTokens ?? 0;
      state.totalCostUsd = forked.totalCostUsd ?? 0;
      state.costIncomplete = forked.costIncomplete ?? forked.totalTokens > 0;
      state.contextSource = "estimated";
      state.totalPromptTokens = 0;
      state.totalCompletionTokens = 0;
      resetUsageDetails();
      const msgs = runtime.database.loadMessages(forked.id);
      const history = runtime.database.loadFullMessages(forked.id);
      state.messages = msgs;
      state.contextTokens = estimateContextTokens(state.mode, state.messages);
      state.contextRequestBytes = 0;
      state.contextInputBudget = 0;
      state.contextBufferTokens = 0;
      warnLargeSession(forked.id, forked.totalTokens, msgs);
      const invokedSkills = new Set(runtime.database.listSessionSkillLoads(forked.id).filter((load) => load.invoked).map(skillSourceKey));
      state.activeSkills = visibleSkillLoads(msgs, runtime.orchestrator.skills.listDocuments().filter(skillEnabled)).filter((load) => {
        const document = runtime.orchestrator.skills.get(load.id);
        return document && (!(document.autoinvoke === false || document.hidden) || load.invoked || invokedSkills.has(skillSourceKey(load)));
      }).map((load) => load.id);
      state.entries = buildTranscriptEntries(history, runtime.database.getCompaction(forked.id));
      state.counter = state.entries.length;
      pushEntry("system", `session forked to: ${forked.title}`);
      rerender();
    },
    onRestoreSnapshot: (result: RestoreResult) => {
      if (!viewLease.isCurrent()) return;
      pushEntry("system", `restored snapshot ${result.snapshotId}: ${result.restoredFiles.length} file(s) restored`);
      rerender();
    },
    onRequestRestoreSnapshot: (snapshotId: string) => {
      if (!viewLease.isCurrent()) return false;
      const text = `/restore ${snapshotId}`;
      return inputRouter.submit({ text, action: interpretInput(text) });
    },
    onSessionDeleted: (sessionId: string) => {
      if (state.sessionId !== sessionId) return;
      inputQueue.cancelActive();
      activeAbortController?.abort();
      if (questionResolver) {
        const resolve = questionResolver;
        questionResolver = undefined;
        pendingQuestion = undefined;
        resolve({ selected: [], cancelled: true });
      }
      approvals.cancelAll("Active session deleted.");
      resetToWelcome();
      setNotice("Session deleted. Starting a new draft.", 5000);
      rerender();
    },
    pendingApproval: approvals.current(),
    onApprovalDecision: (decision: ApprovalDecision) => {
      if (!viewLease.isCurrent()) return;
      const current = approvals.current();
      if (current) approvals.resolve(current.id, decision);
      rerender();
    },
    pendingQuestion,
    onQuestionAnswer: (answer: QuestionAnswer) => {
      if (!viewLease.isCurrent()) return;
      const request = pendingQuestion;
      const resolver = questionResolver;
      pendingQuestion = undefined;
      questionResolver = undefined;
      if (request) {
        const nextMode = modeFromQuestionAnswer(
          request.question,
          [...answer.selected, answer.custom ?? ""],
          request.mode_options,
        );
        if (nextMode) {
          setActiveMode(nextMode);
          // The running turn is still on the old profile, so tell it to switch
          // at its next tool boundary instead of blocking the work it was asked for.
          runtime.orchestrator.requestModeSwitch(nextMode);
          // The turn emits mode_changed, which writes the transcript entry; the
          // notice covers the case where the user aborts before that arrives.
          setNotice(`mode switched to ${nextMode}`, 4000);
        }
      }
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
      approvals.cancelForWorker(workerId, "worker stopped");
      setNotice(`stopping ${workerId}...`, 5000);
      void runtime.orchestrator.stopWorker(workerId).then((stopped) => {
        if (!viewLease.isCurrent()) return;
        refreshSessionUsage();
        pushEntry(
          "system",
          stopped ? `stopped ${workerId}` : `${workerId} was already finished`,
        );
        rerender();
      });
      rerender();
    },
    onKillAll: () => {
      approvals.cancelAll("all workers stopped");
      setNotice("stopping all workers...", 5000);
      void runtime.orchestrator.stopAllWorkers().then(() => {
        if (!viewLease.isCurrent()) return;
        refreshSessionUsage();
        pushEntry("system", "stopped all workers");
        rerender();
      });
      rerender();
    },
    onAbort: abortMainTurn,
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
      void shutdown();
    },
    onSubmit: (text: string, action: InputAction, attachments?: FileAttachmentRef[]) => {
      if (!viewLease.isCurrent()) return false;
      return handleInput(text, action, attachments);
    },
    onDraftChange: (hasDraft: boolean) => {
      hasComposerDraft = hasDraft;
      backgroundJobs.activity();
      const hadRecap = hasDraft && state.entries.some((entry) => entry.id.startsWith("recap-"));
      if (hadRecap) state.entries = state.entries.filter((entry) => !entry.id.startsWith("recap-"));
      if (hadRecap) rerender();
      backgroundJobs.refresh();
    },
    onInteractionBlockedChange: (blocked: boolean) => {
      hasOpenInteraction = blocked;
      backgroundJobs.refresh();
    },
  });
  };
  const synced = installSynchronizedOutput({});
  const terminalRenderer = new TerminalRenderer({ output: synced, onFrame: (frame) => void relay?.broadcast(frame) });
  let instance: ReturnType<typeof render>;
  instance = render(React.createElement(OrchivoxApp, view()), { stdout: terminalRenderer.stdout, debug: true });
  const rerender = (): void => {
    if (shuttingDown) return;
    backgroundJobs.refresh();
    instance.rerender(React.createElement(OrchivoxApp, view()));
  };
  const unsubscribeCapabilities = runtime.router.onCapabilitiesChanged(rerender);
  const unsubscribeMcpAuth = runtime.mcpClient.onAuthChange(rerender);
  const unsubscribeMcpLifecycle = runtime.mcpClient.subscribe(() => { refreshSkillDiagnostics(); rerender(); });
  const renderStreamFrame = (): void => {
    const startedAt = performance.now();
    rerender();
    const duration = performance.now() - startedAt;
    if (duration >= 50) logFreeze("render", {
      ms: Math.round(duration), entries: state.entries.length,
      live_chars: state.streamingText.length, live_tools: state.liveEntry?.toolCalls?.length ?? 0,
    });
  };
  const unsubscribeBtw = runtime.orchestrator.btw.subscribe((turn) => {
    if (shuttingDown || turn.sessionId !== state.sessionId) return;
    const index = btwTurns.findIndex((entry) => entry.id === turn.id);
    if (index < 0) btwTurns = [...btwTurns, turn];
    else btwTurns = btwTurns.map((entry) => entry.id === turn.id ? turn : entry);
    if (turn.status !== "running") refreshSessionUsage();
    terminalRenderer.clock.request(renderStreamFrame);
  });
  const unsubscribeSubagentResults = runtime.orchestrator.onSubagentResult((worker, _text, message) => {
    if (!state.sessionId || worker.parentSessionId !== state.sessionId) return;
    if (message && !state.messages.some((entry) => entry.id === message.id)) {
      state.messages = [...state.messages, message];
    }
    rerender();
  });

  const activityTimer = setInterval(() => {
    backgroundJobs.refresh();
    pruneStoppedApprovals();
    const tokensBefore = state.totalTokens;
    const costBefore = state.totalCostUsd;
    refreshSessionUsage();
    const usageChanged = tokensBefore !== state.totalTokens || costBefore !== state.totalCostUsd;
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
    if (activeWorker || activeTask || usageChanged) rerender();
  }, 750);

  const executeTurn = async (
    promptText: string,
    displayUserText?: string,
    targetAgent?: string,
    attachments?: FileAttachmentRef[],
    options: {
      task?: AgentRunRequest["task"];
      context?: string;
      run?: InputRunContext;
    } = {},
  ): Promise<InputRunResult> => {
    options.run?.assertCurrent();
    if (state.sessionId && !runtime.database.getSession(state.sessionId)) {
      resetToWelcome();
      setNotice("The active session was deleted. Starting a new session.", 5000);
      return { status: "interrupted", reason: "The session was deleted before processing." };
    }
    pushEntry("user", displayUserText ?? promptText);
    for (const attachment of attachments ?? []) {
      if (attachment.kind === "image" && attachment.error) {
        pushEntry("system", `image skipped: ${attachment.filePath} (${attachment.error})`);
      }
    }
    const previousSessionMode = state.sessionId
      ? runtime.database.getSession(state.sessionId)?.mode
      : undefined;
    const sessionId = ensureSession(displayUserText ?? promptText);
    const lease = new SessionViewLease({ id: sessionId, epoch: state.sessionEpoch }, () => ({ id: state.sessionId, epoch: state.sessionEpoch, closed: shuttingDown }), options.run);
    state.entries = state.entries.filter((entry) => !entry.id.startsWith("recap-"));
    backgroundJobs.beginTurn(sessionId);
    runtime.orchestrator.cancelSideTurns(sessionId);
    let recapEligible = false;
    let sawContextUpdate = false;
    const saveSystemLine = (text: string, metadata: Record<string, unknown> = {}): void => {
      try {
        runtime.database.saveMessage(sessionId, {
          id: `system-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          role: "system",
          content: [{ type: "text", text }],
          created_at: Date.now(),
          metadata,
        });
      } catch {
        // Session persistence is best effort.
      }
    };
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
    const estimatedPromptTokens = estimateContextTokens(state.mode, state.messages);
    state.turnPromptTokens = 0;
    state.turnCompletionTokens = 0;
    state.turnTotalTokens = 0;
    state.turnRequests = 0;
    // The orchestrator compacts before each provider request, because it sees
    // the exact payload. The TUI only renders the compaction events.
    const turnMode = state.mode;
    const turnModel = runtime.router.getModeModel(turnMode)?.model;
    const turnStartedAt = Date.now();
    const turnStartedClock = performance.now();
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
    const startThinkingSegment = (kind: "thinking" | "text" = "thinking"): ThinkingSegmentView => {
      const segment: ThinkingSegmentView = {
        id: `thinking-${Date.now().toString(36)}-${++thinkingCounter}`,
        kind,
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
    const turnController = new AbortController();
    activeAbortController = turnController;
    const turnSignal = options.run ? AbortSignal.any([turnController.signal, options.run.signal]) : turnController.signal;
    const renderFrame = (): void => {
      if (lease.isCurrent()) renderStreamFrame();
    };
    const renderLive = (_force = false): void => terminalRenderer.clock.request(renderStreamFrame);
    renderFrame();
    try {
      const runContext = [
        previousSessionMode && previousSessionMode !== state.mode
          ? modeTransitionReminder(previousSessionMode, state.mode)
          : "",
        options.context ?? "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const request = AgentRunRequestSchema.parse({
        profile: modeToProfile(turnMode),
        messages: state.messages,
        ...(runContext ? { context: runContext } : {}),
        task: options.task,
        metadata: {
          ...(targetAgent ? { agent: targetAgent } : {}),
          session_id: sessionId,
        },
        reasoning_effort: reasoningEffortToRequest(state.reasoningEffort),
      });
      let answer = "";
      const answerStream = createAnswerStream();
      let sawUsage = false;
      let finishReason: string | undefined;
      let firstTokenAt: number | undefined;
      let lastTokenAt: number | undefined;
      let lastToolEndAt = turnStartedAt;
      let thinkingStartedAt: number | undefined;
      let thinkingCompletedAt: number | undefined;
      let completionTokens = 0;
      let lastUsage: { prompt_tokens: number; completion_tokens: number; total_tokens?: number } | undefined;
      let sawErrorEvent = false;
      let fatalError = false;
      let lastTurnError: string | undefined;
      let titleScheduled = false;
      const turnFiles = new Set<string>();
      for await (const event of mainTurnEvents(runtime.orchestrator.runStream(request, turnSignal), turnSignal)) {
        if (!lease.isCurrent()) return { status: "interrupted", reason: "The session view changed." };
        if (!titleScheduled && (event.type === "token" || event.type === "thinking_token" || event.type === "tool_start")) {
          titleScheduled = true;
          maybeGenerateSessionTitle(sessionId);
        }
        if (event.type === "token") {
          const now = Date.now();
          if (firstTokenAt === undefined) firstTokenAt = now;
          lastTokenAt = now;
          closeThinkingSegment();
          appendAnswerToken(answerStream, event.text);
          answer = answerStream.text;
          liveEntry.text = answer;
          state.streamingText = answer;
          renderLive();
        } else if (event.type === "final_text") {
          closeThinkingSegment();
          replaceAnswer(answerStream, event.text);
          answer = answerStream.text;
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
          const narration = takeAnswer(answerStream);
          if (narration.trim().length > 0) {
            const segment = startThinkingSegment("text");
            segment.text = narration.trim();
            liveEntry.thinkingSegments = thinkingSegments;
            closeThinkingSegment();
          }
          answer = "";
          liveEntry.text = "";
          state.streamingText = "";
          liveEntry.toolCalls = [
            ...(liveEntry.toolCalls ?? []),
            {
              id: event.id,
              name: event.name,
              label: event.label,
              detail: event.file_path
                ? relative(root, event.file_path) || event.file_path
                : event.detail,
              filePath: event.file_path
                ? relative(root, event.file_path) || event.file_path
                : undefined,
              command: event.command,
              argumentsSummary: event.arguments_summary,
              workerIds: event.worker_ids,
              status: "running",
              startedAt: Date.now(),
            },
          ];
          renderLive(true);
        } else if (event.type === "tool_progress") {
          liveEntry.toolCalls = (liveEntry.toolCalls ?? []).map((call) => call.id === event.id && call.status === "running" ? { ...call, progress: event.progress } : call);
          renderLive();
        } else if (event.type === "tool_end") {
          lastToolEndAt = Date.now();
          liveEntry.toolCalls = (liveEntry.toolCalls ?? []).map((call) =>
            call.id === event.id
              ? {
                  ...call,
                  status: event.status,
                  outcome: event.outcome,
                  metadata: event.metadata,
                  durationMs: event.duration_ms,
                  output: event.output ?? call.output,
                  workerIds: event.worker_ids ?? call.workerIds,
                }
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
          const targetCall = liveEntry.toolCalls?.find((call) => call.id === event.tool_call_id);
          const action =
            targetCall?.name === "create_file"
              ? "create"
              : targetCall?.name === "delete_file"
                ? "delete"
                : targetCall?.name === "move_file"
                  ? "move"
                  : event.old_text.length === 0
                    ? "create"
                    : "edit";
          if (event.tool_call_id) {
            liveEntry.toolCalls = (liveEntry.toolCalls ?? []).map((call) =>
              call.id === event.tool_call_id
                ? {
                    ...call,
                    filePath: displayPath,
                    diff: {
                      oldText: event.old_text,
                      newText: event.new_text,
                      oldLabel: `a/${displayPath}`,
                      newLabel: `b/${displayPath}`,
                      additions: event.additions,
                      deletions: event.deletions,
                      action,
                    },
                  }
                : call,
            );
          }
          const existing = state.modifiedFiles.get(event.path);
          state.modifiedFiles.set(event.path, {
            path: displayPath,
            additions: (existing?.additions ?? 0) + event.additions,
            deletions: (existing?.deletions ?? 0) + event.deletions,
          });
          turnFiles.add(event.path);
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
        } else if (event.type === "retry_scheduled") {
          const seconds = Math.max(1, Math.round(event.delay_ms / 1000));
          setNotice(
            `provider retry ${event.attempt}/${event.max_attempts} in ${seconds}s`,
            event.delay_ms + 3000,
          );
          renderLive(true);
        } else if (event.type === "mode_changed") {
          setActiveMode(event.to);
          pushEntry("system", `mode switched to ${event.to}`);
          renderLive(true);
        } else if (event.type === "context_pruned") {
          if (event.message_ids.length > 0) {
            state.messages = markPrunedToolResults(state.messages, event.message_ids);
          }
          setNotice(
            `context pruned: ${formatTokenCount(event.tokens)} tokens from ${event.results} old tool result${event.results === 1 ? "" : "s"}`,
            6000,
          );
          renderLive();
        } else if (event.type === "compaction_start") {
          beginCompaction(event.reason, event.attempt, event.max_attempts);
          renderLive(true);
        } else if (event.type === "compaction") {
          applyCompactionMeter(state, event);
          finishCompaction({
            summary: event.summary,
            beforeTokens: event.before_tokens,
            afterTokens: event.after_tokens,
            removedMessages: event.removed_messages,
            auto: event.reason !== "manual",
            reason: event.reason,
            trigger: event.trigger,
            requestBytes: event.request_bytes,
            maxRequestBytes: event.max_request_bytes,
            inputBudget: event.input_budget,
            bufferTokens: event.buffer_tokens,
            attempt: event.attempt,
            maxAttempts: event.max_attempts,
            status: event.status,
            error: event.error,
          });
          renderLive(true);
        } else if (event.type === "error") {
          lastTurnError = event.code === "tool_arguments_parse_error" ? `Invalid tool arguments: ${event.message}` : event.message;
          if (!event.recoverable) fatalError = true;
          const actionable = event.code === "context_overflow";
          const knownLimit =
            /UnsupportedParamsError|does not support (?:the )?(?:parameter|parameters|param|params)|unsupported (?:parameter|parameters|param|params)|maximum context length|requested\s+\d+\s+output tokens/i.test(
              event.message,
            );
          if (actionable) {
            pushEntry("system", event.message);
            saveSystemLine(event.message, { event: "error", code: event.code });
            sawErrorEvent = true;
            state.lastOutcome = `error: ${event.code}`;
            await appendErrorLog({
              at: Date.now(),
              session_id: sessionId,
              mode: turnMode,
              model: turnModel,
              finish_reason: "error",
              message: event.message,
              turn_tokens: state.turnTotalTokens,
            });
            renderLive(true);
          } else if (!knownLimit) {
            const display =
              event.code === "provider_adjusted" || event.code === "reasoning_stall"
                ? event.message
                : `provider error: ${event.message}`;
            pushEntry("system", display);
            saveSystemLine(display, { event: "error", code: event.code });
            sawErrorEvent = true;
            state.lastOutcome = `error: ${event.code}`;
            await appendErrorLog({
              at: Date.now(),
              session_id: sessionId,
              mode: turnMode,
              model: turnModel,
              finish_reason: "error",
              message: display,
              turn_tokens: state.turnTotalTokens,
            });
            renderLive(true);
          }
        } else if (event.type === "done") {
          closeThinkingSegment();
          finishReason = event.finish_reason;
        } else if (event.type === "step_started") {
          liveEntry.step = event.step;
          liveEntry.stepLimit = event.step_limit;
          liveEntry.toolLimit = event.tool_limit;
          liveEntry.timeLimitSeconds =
            event.time_limit_ms !== undefined ? Math.ceil(event.time_limit_ms / 1000) : undefined;
          renderLive(true);
        } else if (event.type === "progress_checkpoint") {
          setNotice(`Progress check after ${event.tool_calls} calls: reviewing remaining work and verification evidence.`, 10000);
          pushEntry("system", `Progress check: ${event.tool_calls} calls, ${formatElapsed(Math.round(event.elapsed_ms / 1000))} elapsed. Reviewing remaining work and verification evidence.`);
          renderLive(true);
        } else if (event.type === "turn_budget_warning") {
          const label =
            event.reason === "time" ? "time" : event.reason === "tool" ? "tool calls" : "steps";
          const used =
            event.reason === "time"
              ? formatElapsed(Math.round(event.used / 1000))
              : String(event.used);
          const limit =
            event.reason === "time"
              ? formatElapsed(Math.round(event.limit / 1000))
              : String(event.limit);
          const exhausted = event.used >= event.limit;
          setNotice(
            exhausted
              ? `Turn budget reached: ${used}/${limit} ${label}. Summarizing.`
              : `Turn budget: ${used}/${limit} ${label} used. Finish the current check and summarize.`,
            exhausted ? 8000 : 10000,
          );
        } else if (event.type === "context_estimate") {
          applyContextEstimate(state, event);
          state.lastEstimatedPromptTokens = event.tokens;
          sawContextUpdate = true;
          renderLive(true);
        } else if (event.type === "usage") {
          const usedTokens = event.prompt_tokens + event.completion_tokens;
          lastUsage = {
            prompt_tokens: event.prompt_tokens,
            completion_tokens: event.completion_tokens,
            total_tokens: event.total_tokens,
          };
          if (event.turn_total === true) {
            if (event.cost_incomplete) {
              state.costIncomplete = true;
              try { runtime.database.addSessionUsage(sessionId, 0, 0, true); } catch {}
            }
            // The final event aggregates the whole turn. Per-request events
            // already updated the counters, so only refresh the summary values.
            state.lastCompletionTokens = event.completion_tokens;
            state.lastTotalTokens = event.total_tokens ?? usedTokens;
          } else {
            sawUsage = true;
            sawContextUpdate = true;
            completionTokens = event.completion_tokens;
            applyUsageContext(state, event);
            state.turnRequests += 1;
            if (event.cost_usd === undefined || event.cost_incomplete) state.costIncomplete = true;
            state.lastPromptTokens = event.prompt_tokens;
            state.lastCompletionTokens = event.completion_tokens;
            state.lastTotalTokens = event.total_tokens ?? usedTokens;
            state.turnPromptTokens += event.prompt_tokens;
            state.turnCompletionTokens += event.completion_tokens;
            state.turnTotalTokens += usedTokens;
            state.totalTokens += usedTokens;
            state.totalPromptTokens += event.prompt_tokens;
            state.totalCompletionTokens += event.completion_tokens;
            if (event.cost_usd !== undefined) state.totalCostUsd += event.cost_usd;
            const sessionBudget = runtime.config.limits?.session_tokens;
            if (sessionBudget && !state.tokenBudgetWarned && state.totalTokens >= sessionBudget) {
              state.tokenBudgetWarned = true;
              setNotice(
                `session token budget reached: ${formatTokenCount(state.totalTokens, false)} / ${formatTokenCount(sessionBudget, false)} tokens`,
                12000,
              );
            }
            try {
              runtime.database.addSessionUsage(sessionId, usedTokens, event.cost_usd, event.cost_incomplete);
            } catch {
              // Usage tracking is best effort.
            }
          }
          renderLive();
        }
      }
      if (!lease.isCurrent()) return { status: "interrupted", reason: "The session view changed." };
      answer = answerStream.text;
      const speedStart = Math.max(lastToolEndAt, firstTokenAt ?? lastToolEndAt);
      const streamedMs = (lastTokenAt ?? 0) - speedStart;
      const totalMs = (lastTokenAt ?? Date.now()) - turnStartedAt;
      const generationMs = streamedMs >= 500 ? streamedMs : Math.max(500, totalMs);
      const tokensPerSecond =
        completionTokens > 0 && generationMs > 0
          ? completionTokens / (generationMs / 1000)
          : undefined;
      closeThinkingSegment();
      const aborted =
        finishReason === "aborted" || turnSignal.aborted;
      const result = mainTurnResult(finishReason, aborted, fatalError);
      if (result.status === "failed" && lastTurnError) result.reason = lastTurnError;
      const failedWithoutAnswer =
        answer.trim().length === 0 && (aborted || finishReason === "error");
      const finalToolCalls = finalizeToolCalls(liveEntry.toolCalls);
      const entryMeta = {
        completedAt: Date.now(),
        responseDurationMs: Math.max(0, performance.now() - turnStartedClock),
        thinking: liveEntry.thinking,
        thinkingSegments: thinkingSegments.map((segment) => ({ ...segment })),
        thinkingStartedAt,
        thinkingCompletedAt,
        toolCalls: finalToolCalls,
        files: liveEntry.files,
        mode: turnMode,
        model: turnModel,
        tokensPerSecond,
        turnTokens: sawUsage ? state.turnTotalTokens : undefined,
        turnPromptTokens: sawUsage ? state.turnPromptTokens : undefined,
        turnCompletionTokens: sawUsage ? state.turnCompletionTokens : undefined,
        turnRequests: sawUsage ? state.turnRequests : undefined,
        filesChanged: turnFiles.size,
      };
      if (failedWithoutAnswer) {
        // Keep the reasoning available for inspection, but never save an empty
        // answer or promote buffered reasoning into one.
        pushEntry("assistant", "", entryMeta);
        if (aborted) {
          pushEntry("system", "Turn stopped.");
          saveSystemLine("Turn stopped by the user.", { event: "abort", finish_reason: "aborted" });
          state.lastOutcome = "aborted";
          await appendErrorLog({
            at: Date.now(),
            session_id: sessionId,
            mode: turnMode,
            model: turnModel,
            finish_reason: "aborted",
            message: "Turn stopped by the user.",
            turn_tokens: state.turnTotalTokens,
          });
        } else if (!sawErrorEvent) {
          const text = "Turn ended without an answer.";
          pushEntry("system", text);
          saveSystemLine(text, {
            event: "error",
            finish_reason: finishReason ?? "error",
          });
          state.lastOutcome = `error: ${finishReason ?? "unknown"}`;
          await appendErrorLog({
            at: Date.now(),
            session_id: sessionId,
            mode: turnMode,
            model: turnModel,
            finish_reason: finishReason ?? "error",
            message: text,
            turn_tokens: state.turnTotalTokens,
          });
        }
      } else {
        state.lastOutcome = aborted ? "aborted" : result.status === "failed" ? `stopped: ${finishReason ?? "unknown"}` :
          finishReason === "turn_limit"
            ? "stopped at the step limit"
            : `completed: ${finishReason ?? "stop"}`;
        pushEntry("assistant", answer || "(no output)", entryMeta);
        if (finishReason === "length") {
          pushEntry(
            "system",
            "response truncated after automatic continuation limit; send another message to continue",
          );
        }
        const assistantMsg: Message = {
          id: `assistant-${Date.now().toString(36)}`,
          role: "assistant",
          content: [{ type: "text", text: answer }],
          created_at: entryMeta.completedAt,
          metadata: {
            mode: turnMode,
            model: turnModel,
            tokens_per_second: tokensPerSecond,
            response_duration_ms: entryMeta.responseDurationMs,
            finish_reason: finishReason,
            completion_tokens: lastUsage?.completion_tokens ?? completionTokens,
            prompt_tokens: lastUsage?.prompt_tokens,
            total_tokens: lastUsage
              ? (lastUsage.total_tokens ?? lastUsage.prompt_tokens + lastUsage.completion_tokens)
              : undefined,
            context_window: runtime.router.capabilitiesForMode(turnMode).context_window,
            estimated_prompt_tokens: estimatedPromptTokens,
            turn_tokens: state.turnTotalTokens,
            turn_prompt_tokens: state.turnPromptTokens,
            turn_completion_tokens: state.turnCompletionTokens,
            turn_requests: state.turnRequests,
            usage_reported: sawUsage,
            thinking_segments: thinkingSegments.map((segment) => ({ ...segment })),
            tool_calls: finalToolCalls,
            files_changed: turnFiles.size,
          },
        };
        state.messages = [...state.messages, assistantMsg];
        if (!sawContextUpdate) state.contextTokens = estimateContextTokens(state.mode, state.messages);
        try {
          runtime.database.saveMessage(sessionId, assistantMsg);
        } catch {
          // Ignore database save error if session not found.
        }
        recapEligible = result.status === "complete";
      }
      return result;
    } catch (error) {
      const result = interruptedRun(error, turnSignal);
      if (lease.isCurrent() && result.status === "failed") pushEntry("system", `turn failed: ${result.reason}`);
      return lease.isCurrent() ? result : { status: "interrupted", reason: "The session view changed." };
    } finally {
      if (activeAbortController === turnController) activeAbortController = undefined;
      if (lease.isCurrent()) {
        terminalRenderer.clock.cancel(renderStreamFrame);
        cancelCompaction();
        state.liveEntry = undefined;
        state.streamingText = "";
        refreshSessionUsage();
        if (state.sessionId === sessionId) {
          try {
            state.messages = runtime.database.loadMessages(sessionId);
            finishContextMeter(state, sawContextUpdate, () => estimateContextTokens(state.mode, state.messages));
          } catch {
            // A deleted session must not break the turn.
          }
        }
        state.busy = false;
        backgroundJobs.endTurn(sessionId, recapEligible);
        renderFrame();
      } else {
        try { runtime.database.addSessionUsage(sessionId, 0, undefined, true); } catch { /* The original session may have been deleted. */ }
      }
    }
  };

  const handleCommand = async (command: string, args = "", raw = command, attachments?: FileAttachmentRef[], submittedText = raw, queuedSessionId?: string, run?: InputRunContext): Promise<InputRunResult | void> => {
    const captured = { id: state.sessionId, epoch: state.sessionEpoch };
    const lease = new SessionViewLease(captured, () => ({ id: state.sessionId, epoch: state.sessionEpoch, closed: shuttingDown }), run);
    const callbackLease = new SessionViewLease(captured, () => ({ id: state.sessionId, epoch: state.sessionEpoch, closed: shuttingDown }));
    const checkSession = (): void => {
      lease.assertCurrent();
      if (queuedSessionId && queuedSessionId !== state.sessionId) throw new InputRunCancelled("interrupted");
    };
    checkSession();
    const commandFailed = (prefix: string, error: unknown): InputRunResult => {
      checkSession();
      const reason = `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
      pushEntry("system", reason);
      rerender();
      return { status: "failed", reason };
    };
    switch (command) {
      case "/queue": { openQueue(); break; }
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
        setNotice("Mode: build (workspace autonomy)");
        break;
      }
      case "/ultrawork": {
        setActiveMode("ultrawork");
        setNotice("Mode: ultrawork (autonomous)");
        break;
      }
      case "/study": {
        const command = await withRunSignal(() => buildStudyCommand(root), run?.signal);
        checkSession();
        return executeTurn(command.prompt, command.display, undefined, attachments, {
          task: command.task,
          context: command.context,
          run,
        });
        break;
      }
      case "/review": {
        const command = await withRunSignal(() => buildReviewCommand(root, args), run?.signal);
        checkSession();
        if (!command.request) {
          setNotice(command.error ?? "Could not review that target.", 8000);
          return { status: "failed", reason: command.error ?? "Could not review that target." };
        }
        return executeTurn(command.request.prompt, command.request.display, undefined, attachments, {
          task: command.request.task,
          context: command.request.context,
          run,
        });
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
        if (targetTheme === AUTO_THEME || isThemeName(targetTheme)) {
          applyThemeSelection(targetTheme);
        } else if (!targetTheme) {
          const options = [AUTO_THEME, ...THEME_NAMES].join(", ");
          setNotice(
            `Current theme: ${themeSelectionLabel(state.themeSelection, state.currentTheme)}. Options: ${options}`,
          );
        } else {
          const options = [AUTO_THEME, ...THEME_NAMES].join(", ");
          setNotice(`Unknown theme "${targetTheme}". Options: ${options}`, 8000);
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
      case "/settings": {
        state.settingsOpen = true;
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
        checkSession();
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
        const report = await formatDoctor();
        checkSession();
        pushEntry("system", report);
        break;
      }
      case "/update": {
        setNotice("Checking for updates...");
        try {
          const result = await runUpdate({ check: true });
          checkSession();
          pushEntry("system", result.output);
        } catch (error) {
          return commandFailed("update check failed", error);
        }
        break;
      }
      case "/stats": {
        const sessionCount = runtime.database.listSessions().length;
        const snapshotHistory = await runtime.snapshots.getHistory();
        checkSession();
        const snapshotCount = snapshotHistory.entries.length;
        const taskSummary = runtime.orchestrator.tasks.summary();
        const skillCount = runtime.orchestrator.skills.listDocuments().length;
        const modeModel = runtime.router.getModeModel(state.mode);
        const capabilities = runtime.router.capabilitiesForMode(state.mode);
        const contextWindow = capabilities.context_window;
        const turnMetrics = runtime.orchestrator.getLastTurnMetrics(state.sessionId);
        const allSessionsUsage = runtime.database.getUsageTotals();
        state.report = {
          title: "Session statistics",
          text: formatStatsReport({
            sessionId: state.sessionId,
            messageCount: state.messages.length,
            totalTokens: state.totalTokens,
            lastPromptTokens: state.lastPromptTokens,
            lastEstimatedPromptTokens: state.lastEstimatedPromptTokens,
            lastCompletionTokens: state.lastCompletionTokens,
            lastTotalTokens: state.lastTotalTokens,
            lastOutcome: state.lastOutcome,
            turnMetrics,
            sessionCostUsd: state.totalCostUsd,
            allSessionsCostUsd: allSessionsUsage.costUsd,
            sessionCostIncomplete: state.costIncomplete,
            allSessionsCostIncomplete: allSessionsUsage.costIncomplete,
            contextUsageSource: state.contextSource,
            mode: state.mode,
            modeModel: modeModel ? `${modeModel.provider} / ${modeModel.model}` : undefined,
            contextTokens: state.contextTokens,
            contextWindow,
            contextSource: capabilities.limit_sources?.context ?? capabilities.source ?? "default",
            requestBytes: state.contextRequestBytes,
            maxRequestBytes: state.maxRequestBytes,
            inputBudget: state.contextInputBudget,
            bufferTokens: state.contextBufferTokens,
            prune: runtime.config.compaction.prune,
            pruneProtectTokens: runtime.config.compaction.prune_protect_tokens,
            pruneMinTokens: runtime.config.compaction.prune_min_tokens,
            turnPromptTokens: state.turnPromptTokens,
            turnCompletionTokens: state.turnCompletionTokens,
            turnTotalTokens: state.turnTotalTokens,
            inputLimit: capabilities.max_input,
            inputSource: capabilities.limit_sources?.input ?? "default",
            outputLimit: capabilities.max_output,
            outputSource: capabilities.limit_sources?.output ?? "default",
            reasoningEffort: state.reasoningEffort,
            themeLabel: themeSelectionLabel(state.themeSelection, state.currentTheme),
            mcpLabel: runtime.mcpServers.length > 0 ? runtime.mcpServers.join(", ") : "none",
            pluginLabel:
              runtime.plugins.loaded.length > 0 ? runtime.plugins.loaded.join(", ") : "none",
            skillCount,
            activeSkills: state.activeSkills,
            taskSummary,
            branch,
            snapshotCount,
            sessionCount,
          }),
        };
        rerender();
        break;
      }
      case "/turn-report": {
        const metrics = runtime.orchestrator.getLastTurnMetrics(state.sessionId);
        if (!metrics) {
          setNotice("No turn metrics recorded yet. Run a turn first.");
          break;
        }
        state.report = {
          title: "Turn report",
          text: formatTurnMetrics(metrics),
        };
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
          checkSession();
          pushEntry("system", `undo: ${restored.snapshotId} restored ${restored.restoredFiles.length} file(s)`);
        } catch (error) {
          return commandFailed("undo failed", error);
        }
        break;
      }
      case "/redo": {
        try {
          const restored = await runtime.snapshots.redo();
          checkSession();
          pushEntry("system", `redo: ${restored.snapshotId} restored ${restored.restoredFiles.length} file(s)`);
        } catch (error) {
          return commandFailed("redo failed", error);
        }
        break;
      }
      case "/restore": {
        if (!args.trim()) return commandFailed("restore failed", "Choose a snapshot or provide its ID.");
        try {
          const restored = await runtime.snapshots.restoreTo(args.trim());
          checkSession();
          pushEntry("system", `restored snapshot ${restored.snapshotId}: ${restored.restoredFiles.length} file(s) restored`);
        } catch (error) { return commandFailed("restore failed", error); }
        break;
      }
      case "/commit": {
        try {
          const results = await analyzeAndSplitCommits(runtime.router.get("main"), run?.signal);
          checkSession();
          pushEntry("system", results.length === 0 ? "nothing to commit" : `created ${results.length} commit(s): ${results.map((entry) => entry.message).join(" | ")}`);
        } catch (error) {
          return commandFailed("commit failed", error);
        }
        break;
      }
      case "/compact": {
        const compactSessionId = state.sessionId;
        if (state.busy) {
          setNotice("Cancel the running turn before compacting.", 8000);
          break;
        }
        let provider: LLMProvider;
        try {
          provider = runtime.router.getMode(state.mode);
        } catch (error) {
          return commandFailed("compact failed", error);
        }
        const compactionConfig = runtime.config.compaction;
        const capabilities = runtime.router.capabilitiesForMode(state.mode);
        state.busy = true;
        if (noticeTimer) clearTimeout(noticeTimer);
        state.notice = undefined;
        rerender();
        try {
          const result = await compactMessages(state.messages, {
            provider,
            signal: run?.signal,
            onUsage: (usage) => { if (compactSessionId) runtime.database.addSessionUsage(compactSessionId, usage.prompt_tokens + usage.completion_tokens, usage.cost_usd, usage.cost_incomplete); },
            contextWindow: capabilities.context_window,
            inputLimit: capabilities.max_input,
            outputLimit: capabilities.max_output,
            keepTokens: compactionConfig.keep_tokens,
            bufferTokens: compactionConfig.buffer_tokens,
            bufferRatio: compactionConfig.buffer_ratio,
            overheadTokens: runtime.orchestrator.estimateContextOverhead(state.mode),
            previousSummary: extractSummary(state.messages),
            force: true,
            onStart: () => {
              if (!lease.isCurrent()) return;
              beginCompaction("manual");
              rerender();
            },
          });
          checkSession();
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
            finishCompaction({
              summary: result.summary,
              beforeTokens: result.beforeTokens,
              afterTokens: result.afterTokens,
              removedMessages: result.removedMessages,
              auto: false,
              reason: "manual",
            });
          }
        } catch (error) {
          if (lease.isCurrent()) cancelCompaction();
          return commandFailed("compact failed", error);
        } finally {
          if (lease.isCurrent()) {
            if (run?.signal.aborted) cancelCompaction();
            refreshSessionUsage();
            state.busy = false;
            rerender();
          }
        }
        break;
      }
      case "/mcp": {
        if (!args.trim()) { state.mcpOpen = true; state.mcpAuthServer = undefined; break; }
        const [mcpAction, mcpServer] = args.trim().split(/\s+/);
        if (mcpAction === "login" && Object.hasOwn(runtime.config.mcp.servers, mcpServer)) { state.mcpOpen = true; state.mcpAuthServer = mcpServer; rerender(); }
        try {
          const text = await executeMcpCommand(args);
          checkSession();
          if (mcpAction === "login" && state.mcpOpen) setNotice(text, 9000);
          else state.report = { title: "MCP", text };
        } catch (error) { setNotice(error instanceof Error ? error.message : String(error), 9000); }
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
        if (state.busy || inputQueue.active) {
          setNotice("Cancel the running turn before starting a new session.", 8000);
          break;
        }
        leaveBtwSession();
        cancelBackgroundView();
        state.sessionId = undefined;
        state.sessionEpoch += 1;
        queueEdit = undefined;
        queueOpen = false;
        inputQueue.switchSession(`draft-${state.sessionEpoch}`);
        state.messages = [];
        state.entries = [];
        state.counter = 0;
        state.streamingText = "";
        state.liveEntry = undefined;
        state.activeSkills = [];
        state.modifiedFiles.clear();
        state.report = undefined;
        state.totalTokens = 0;
        state.contextTokens = 0;
        state.contextRequestBytes = 0;
        state.contextInputBudget = 0;
        state.contextBufferTokens = 0;
        state.maxRequestBytes = runtime.config.limits.max_request_bytes;
        state.totalPromptTokens = 0;
        state.totalCompletionTokens = 0;
        state.totalCostUsd = 0;
        resetUsageDetails();
        setNotice("Started a new draft session");
        setTerminalTitle(`Orchivox - ${projectName}`);
        rerender();
        break;
      }
      case "/reload": {
        if (state.busy) {
          setNotice("Cancel the running turn before reloading.", 8000);
          break;
        }
        const report = await runtime.orchestrator.reload();
        checkSession();
        pushEntry(
          "system",
          [
            `reloaded ${report.skills} skills, ${report.commands} commands, ${report.agents} agents`,
            report.rules ? "project rules on" : "no project rules",
            report.projectContext ? "project summary rebuilt" : "project summary unavailable",
          ].join(" · "),
        );
        setNotice("Reloaded skills, commands, agents, and rules");
        rerender();
        break;
      }
      case "/cleanup": {
        if (state.busy) {
          setNotice("Cancel the running turn before cleanup.", 8000);
          break;
        }
        const report = await runCleanup({ aggressive: true });
        checkSession();
        const noun = report.removed === 1 ? "entry" : "entries";
        const text = `cleanup removed ${report.removed} ${noun} and freed ${formatBytes(report.freedBytes)}`;
        pushEntry("system", text);
        setNotice(text, 6000);
        rerender();
        break;
      }
      case "/clear": {
        state.entries = [];
        state.report = undefined;
        state.notice = undefined;
        break;
      }
      case "/exit":
      case "/quit": {
        pushEntry("system", "shutting down Orchivox...");
        rerender();
        unsubscribeSubagentResults();
        cleanupSignals();
        return;
      }
      default: {
        try {
          const customCmd = await runtime.orchestrator.customCommands.getCommand(command);
          checkSession();
          if (customCmd) {
            const executed = await runtime.orchestrator.customCommands.executeCommand(command, args, run?.signal);
            checkSession();
            if (executed) {
              if (executed.subtask) {
                const worker = runtime.orchestrator.subagents.spawnOne({
                  agent: executed.agent,
                  task: executed.prompt,
                  writeIsolation: true,
                  onComplete: (w) => {
                    if (!callbackLease.isCurrent()) return;
                    pushEntry("system", `subtask ${w.id} (${w.status}): ${w.result?.output.slice(0, 100) ?? ""}`);
                    rerender();
                  },
                });
                pushEntry("system", `running /${customCmd.name} as subtask: ${worker.id}`);
              } else {
                return executeTurn(executed.prompt, raw, executed.agent, attachments, { run });
              }
              break;
            }
          }
        } catch (error) {
          checkSession();
          pushEntry("system", `custom command execution failed: ${error instanceof Error ? error.message : String(error)}`);
          return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
        }
        // Not a builtin and not a custom command: send the line as a normal
        // message instead of rejecting it.
        return executeTurn(submittedText, raw, undefined, attachments, { run });
      }
    }
    rerender();
  };

  const handleInput = (
    text: string,
    action: InputAction,
    attachments?: FileAttachmentRef[],
  ): boolean => {
    return inputRouter.submit({ text, action, attachments });
  };

  let shutdownPromise: Promise<void> | undefined;
  let updateTimer: ReturnType<typeof setInterval> | undefined;
  const updateAbort = new AbortController();
  let checkingUpdate = false;
  const checkUpdates = async (): Promise<void> => {
    if (checkingUpdate || shuttingDown) return;
    checkingUpdate = true;
    try {
      const info = await getAppInfo();
      const notice = await updateNotice({ currentVersion: info.version,
        cachePath: join(resolveInstallPaths().baseDir, "cache", "update-check.json"),
        check: () => fetchUpdateCheck({ currentVersion: info.version, timeoutMs: 5000, signal: updateAbort.signal }) });
      if (!shuttingDown) { state.updateNotice = notice; rerender(); }
    } catch { /* Automatic checks are silent when offline. */ }
    finally { checkingUpdate = false; }
  };
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    if (updateTimer) clearInterval(updateTimer);
    updateAbort.abort();
    activeAbortController?.abort();
    approvals.cancelAll("Session closed.");
    if (questionResolver) {
      const resolve = questionResolver;
      questionResolver = undefined;
      pendingQuestion = undefined;
      resolve({ selected: [], cancelled: true });
    }
    unsubscribeBtw();
    unsubscribeSubagentResults();
    terminalRenderer.clock.cancel(renderStreamFrame);
    try { inputQueue.close(); } catch (error) { console.error("Could not checkpoint the queue during shutdown:", error); }
    backgroundJobs.close();
    if (noticeTimer) clearTimeout(noticeTimer);
    clearInterval(activityTimer);
    unsubscribeCapabilities();
    unsubscribeMcpAuth();
    unsubscribeMcpLifecycle();
    stopFreezeMonitor();
    terminalRenderer.dispose();
    synced.uninstall();
    setTerminalTitle(projectName);
    leaveTerminal();
    process.removeListener("SIGINT", cleanupSignals);
    process.removeListener("SIGTERM", cleanupSignals);
    uninstallFatalHandlers();
    instance.unmount();
    shutdownPromise = (async () => {
      await inputQueue.drain();
      await relay?.close();
      await runtime.close();
    })();
    return shutdownPromise;
  };
  const cleanupSignals = () => {
    void shutdown().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
  };
  process.on("SIGINT", cleanupSignals);
  process.on("SIGTERM", cleanupSignals);
  rerender();
  if (runtime.config.updates.check) {
    void checkUpdates();
    updateTimer = setInterval(() => { void checkUpdates(); }, UPDATE_CHECK_INTERVAL);
    updateTimer.unref?.();
  }
  await instance.waitUntilExit();
  await shutdown();
  print("session closed");
  return { close: async () => undefined };
}

if (import.meta.main || isCompiledExecutable()) {
  void main(userArgs())
    .then(async () => {
      await flushOutput();
    })
    .catch(async (error: unknown) => {
      const cancelled =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "cancelled";
      if (!cancelled) {
        console.error(error instanceof Error ? error.message : String(error));
      }
      await flushOutput();
      globalThis.process.exit(cancelled ? 130 : 1);
    });
}

async function writeStdout(text: string): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => {
      process.stdout.write(`${text}\n`, () => resolve());
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
}

async function flushOutput(): Promise<void> {
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
}

async function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => {
      stream.write("", () => resolve());
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 250)),
  ]);
}
