import React from "react";
import { Box, Text, render, useInput, useStdin } from "ink";

import type { AgentMode, Message } from "../types/schema";
import type { SubagentWorkerState } from "../agent/subagent";
import type { SkillDocument } from "../agent/skills";
import type { TaskItem } from "../agent/task-board";
import type { ApprovalDecision, ApprovalRequest } from "../agent/permissions";
import type { ProviderRouter } from "../provider/router";
import type { MemoryDatabase, SessionRecord } from "../memory/sqlite";
import type { RestoreResult, SnapshotManager } from "../vcs/snapshot";
import type { ConfigMode, ConfigRole } from "../config/writer";
import { AgentHub, type AgentHubTab } from "./agent-hub";
import { ToolApprovalModal } from "./approval-modal";
import { ChoiceModal } from "./choice-modal";
import { CommandPaletteModal, REASONING_LEVELS, reasoningLevelsFor, type ReasoningEffortLevel } from "./command-palette";
import { PromptComposer, type FileAttachmentRef } from "./composer";
import { HelpOverlay } from "./help-overlay";
import { QuestionModal, type PendingQuestion } from "./question-modal";
import type { QuestionAnswer } from "../tools/question";
import { OrchivoxLogo } from "./logo";
import { ModelConfigModal } from "./model-modal";
import { SessionTimeTravelModal, type SessionModalTab } from "./session-modal";
import { SkillsModal } from "./skills-modal";
import { contextUsagePercent, formatContextUsage, formatCost } from "./format";
import { isMouseSequence, parseMouseWheel } from "./mouse";
import { ThemeProvider, getTheme, type ThemeName } from "./theme";
import {
  ScrollableChatViewport,
  WorkspaceSidebar,
  useTerminalSize,
  type SidebarFile,
  type SidebarSubagent,
  type SidebarTodo,
} from "./viewport";

export const SYNC_START = "\u001b[?2026h";
export const SYNC_END = "\u001b[?2026l";

export interface WriteTarget {
  write(chunk: string | Uint8Array, callback?: () => void): boolean;
}

export interface SyncedOutputHandle {
  flush: () => void;
  uninstall: () => void;
}

export type InputAction =
  | { kind: "command"; command: string; args?: string; raw?: string }
  | { kind: "submit"; text: string; ultrawork: boolean };

export interface ChatToolCallView {
  id?: string;
  name: string;
  label?: string;
  detail?: string;
  argumentsSummary: string;
  durationMs?: number;
  status?: "running" | "ok" | "error";
  lspStatus?: string;
}

export interface ChatFileChangeView {
  path: string;
  oldText: string;
  newText: string;
  additions?: number;
  deletions?: number;
}

export interface ChatCompactionView {
  beforeTokens: number;
  afterTokens: number;
  removedMessages: number;
  auto?: boolean;
  status?: "running" | "done" | "error";
  error?: string;
}

export interface ChatEntryView {
  id: string;
  role: "user" | "assistant" | "system" | "compaction";
  text: string;
  thinking?: string;
  toolCalls?: ChatToolCallView[];
  files?: ChatFileChangeView[];
  live?: boolean;
  startedAt?: number;
  mode?: AgentMode;
  model?: string;
  tokensPerSecond?: number;
  diff?: { oldText: string; newText: string; oldLabel?: string; newLabel?: string; unified?: boolean };
  compaction?: ChatCompactionView;
}

export interface OrchivoxAppProps {
  projectName?: string;
  branch?: string;
  mcpCount?: number;
  pluginCount?: number;
  totalTokens?: number;
  contextTokens?: number;
  totalCostUsd?: number;
  entries: ChatEntryView[];
  streamingText?: string;
  liveEntry?: ChatEntryView;
  busy?: boolean;
  mode?: AgentMode;
  onModeChange?: (mode: AgentMode) => void;
  onSubmit?: (text: string, action: InputAction, attachments?: FileAttachmentRef[]) => void;
  onAbort?: () => void;
  workers?: SubagentWorkerState[];
  onSteer?: (workerId: string, instruction: string) => void;
  onKill?: (workerId: string) => void;
  pendingApproval?: ApprovalRequest;
  onApprovalDecision?: (decision: ApprovalDecision) => void;
  pendingQuestion?: PendingQuestion;
  onQuestionAnswer?: (answer: QuestionAnswer) => void;
  router?: ProviderRouter;
  database?: MemoryDatabase;
  snapshots?: SnapshotManager;
  activeSessionId?: string;
  activeSessionMessages?: Message[];
  currentTheme?: ThemeName;
  onThemeChange?: (theme: ThemeName) => void;
  reasoningEffort?: ReasoningEffortLevel;
  onReasoningEffortChange?: (effort: ReasoningEffortLevel) => void;
  onModeModelChange?: (mode: ConfigMode, provider: string, model: string) => void;
  onModeReasoningChange?: (mode: ConfigMode, reasoning: string) => void;
  onForkSession?: (forkedSession: SessionRecord) => void;
  onResumeSession?: (sessionId: string) => void;
  onNewSession?: () => void;
  onSessionDeleted?: (sessionId: string) => void;
  onRestoreSnapshot?: (result: RestoreResult) => void;
  todos?: SidebarTodo[];
  modifiedFiles?: SidebarFile[];
  lspStatus?: string;
  mcpServers?: string[];
  statusMessage?: string;
  onStatusMessage?: (message: string) => void;
  helpOpen?: boolean;
  onHelpOpenChange?: (open: boolean) => void;
  modelsOpen?: boolean;
  modelsView?: "models" | "providers";
  onModelsOpenChange?: (open: boolean) => void;
  onModelsViewChange?: (view: "models" | "providers") => void;
  hubOpen?: boolean;
  onHubOpenChange?: (open: boolean) => void;
  hubTab?: AgentHubTab;
  onHubTabChange?: (tab: AgentHubTab) => void;
  tasks?: TaskItem[];
  onCancelTask?: (id: string) => void;
  onDispatchTasks?: () => void;
  onMergeTask?: (id: string) => void;
  skills?: SkillDocument[];
  activeSkills?: string[];
  skillsOpen?: boolean;
  onSkillsOpenChange?: (open: boolean) => void;
  onReloadSkills?: () => void;
  paletteOpen?: boolean;
  onPaletteOpenChange?: (open: boolean) => void;
  sessionTab?: SessionModalTab | null;
  onSessionTabChange?: (tab: SessionModalTab | null) => void;
  onRoleChange?: (role: ConfigRole, provider: string, model: string) => void;
  configPath?: string;
  secretsPath?: string;
}

const MODE_ORDER: AgentMode[] = ["plan", "build", "ultrawork"];

const MODE_HINTS: Record<AgentMode, string> = {
  plan: "read-only",
  build: "approval on write",
  ultrawork: "autonomous",
};

const MODE_CHOICES: Array<{ id: AgentMode; label: string; description: string }> = [
  { id: "plan", label: "Plan", description: "Read-only. Inspect and plan, no file changes." },
  { id: "build", label: "Build", description: "Normal work. File changes ask for approval." },
  {
    id: "ultrawork",
    label: "Ultrawork",
    description: "Autonomous. Keeps working without stopping for approval.",
  },
];

export function interpretInput(text: string): InputAction {
  const trimmed = text.trim();
  if (trimmed.startsWith("/")) {
    const spaceIndex = trimmed.indexOf(" ");
    const command = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
    const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
    return { kind: "command", command, args, raw: trimmed };
  }
  const lower = trimmed.toLowerCase();
  const ultrawork = /^(ulw|ultrawork)\b/.test(lower);
  return { kind: "submit", text: trimmed, ultrawork };
}

export { formatCost } from "./format";

export function computeViewportHeight(rows: number, chromeRows: number, composerRows: number): number {
  return Math.max(3, rows - chromeRows - composerRows - 1);
}

export function installSynchronizedOutput(
  options: { frameMs?: number; target?: WriteTarget; onFrame?: (frame: string) => void },
): SyncedOutputHandle {
  const target = options.target ?? (process.stdout as unknown as WriteTarget);
  const frameMs = options.frameMs ?? 16;
  const originalWrite = target.write.bind(target);
  let pending: Array<string | Uint8Array> = [];
  let callbacks: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending.length === 0) return;
    const chunks = pending;
    const done = callbacks;
    pending = [];
    callbacks = [];
    originalWrite(SYNC_START);
    for (const chunk of chunks) originalWrite(chunk);
    originalWrite(SYNC_END);
    if (options.onFrame) {
      options.onFrame(chunks.map((chunk) => (typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))).join(""));
    }
    for (const callback of done) callback();
  };

  (target as unknown as { write: unknown }).write = ((
    chunk: string | Uint8Array,
    encoding?: unknown,
    callback?: unknown,
  ) => {
    pending.push(chunk);
    if (typeof callback === "function") callbacks.push(callback as () => void);
    if (timer === undefined) timer = setTimeout(flush, frameMs);
    return true;
  }) as unknown as WriteTarget["write"];

  return {
    flush,
    uninstall: () => {
      flush();
      (target as unknown as { write: unknown }).write = originalWrite;
    },
  };
}

export function OrchivoxApp(props: OrchivoxAppProps) {
  const {
    projectName = "orchivox-agent",
    branch = "main",
    contextTokens = 0,
    totalCostUsd = 0,
    entries,
    streamingText,
    liveEntry,
    busy = false,
    workers = [],
    onSteer = () => undefined,
    onKill = () => undefined,
    onSubmit = () => undefined,
    onModeChange = () => undefined,
    onAbort,
    todos = [],
    modifiedFiles = [],
    lspStatus = "ready",
    mcpServers = [],
    statusMessage,
    onStatusMessage,
    onRoleChange,
    configPath = `${globalThis.process.cwd()}/.agent/config.yaml`,
    secretsPath = `${globalThis.process.cwd()}/.agent/secrets.yaml`,
  } = props;

  const [internalMode, setInternalMode] = React.useState<AgentMode>("build");
  const mode = props.mode ?? internalMode;

  const [internalHelpOpen, setInternalHelpOpen] = React.useState(false);
  const [internalModelsOpen, setInternalModelsOpen] = React.useState(false);
  const [internalModelsView, setInternalModelsView] = React.useState<"models" | "providers">(
    "models",
  );
  const [internalSkillsOpen, setInternalSkillsOpen] = React.useState(false);
  const [internalHubOpen, setInternalHubOpen] = React.useState(false);
  const [internalHubTab, setInternalHubTab] = React.useState<AgentHubTab>("workers");
  const [internalPaletteOpen, setInternalPaletteOpen] = React.useState(false);
  const [internalSessionTab, setInternalSessionTab] = React.useState<SessionModalTab | null>(null);
  const [modePickerOpen, setModePickerOpen] = React.useState(false);
  const [reasoningPickerOpen, setReasoningPickerOpen] = React.useState(false);

  const helpOpen = props.helpOpen ?? internalHelpOpen;
  const setHelpOpen = (open: boolean) => {
    if (props.helpOpen === undefined) setInternalHelpOpen(open);
    props.onHelpOpenChange?.(open);
  };

  const modelsOpen = props.modelsOpen ?? internalModelsOpen;
  const setModelsOpen = (open: boolean) => {
    if (props.modelsOpen === undefined) setInternalModelsOpen(open);
    props.onModelsOpenChange?.(open);
  };
  const modelsView = props.modelsView ?? internalModelsView;
  const setModelsView = (view: "models" | "providers") => {
    if (props.modelsView === undefined) setInternalModelsView(view);
    props.onModelsViewChange?.(view);
  };

  const hubOpen = props.hubOpen ?? internalHubOpen;
  const setHubOpen = (open: boolean) => {
    if (props.hubOpen === undefined) setInternalHubOpen(open);
    props.onHubOpenChange?.(open);
  };

  const hubTab = props.hubTab ?? internalHubTab;
  const setHubTab = (tab: AgentHubTab) => {
    if (props.hubTab === undefined) setInternalHubTab(tab);
    props.onHubTabChange?.(tab);
  };

  const skillsOpen = props.skillsOpen ?? internalSkillsOpen;
  const setSkillsOpen = (open: boolean) => {
    if (props.skillsOpen === undefined) setInternalSkillsOpen(open);
    props.onSkillsOpenChange?.(open);
  };

  const paletteOpen = props.paletteOpen ?? internalPaletteOpen;
  const setPaletteOpen = (open: boolean) => {
    if (props.paletteOpen === undefined) setInternalPaletteOpen(open);
    props.onPaletteOpenChange?.(open);
  };

  const sessionTab = props.sessionTab ?? internalSessionTab;
  const setSessionTab = (tab: SessionModalTab | null) => {
    if (props.sessionTab === undefined) setInternalSessionTab(tab);
    props.onSessionTabChange?.(tab);
  };

  const terminalSize = useTerminalSize();
  const theme = getTheme(props.currentTheme ?? "tokyonight");
  const modePalette = theme.modes[mode] ?? theme.modes.build;
  const reasoningOptions = props.router
    ? props.router.reasoningOptionsForMode(mode)
    : REASONING_LEVELS.map((level) => level.id);
  const reasoningLevels = reasoningLevelsFor(reasoningOptions);
  const modeModel = props.router?.getModeModel(mode);
  const modeCapabilities = props.router?.capabilitiesForMode(mode);
  const contextPercent = contextUsagePercent(contextTokens, modeCapabilities?.context_window);
  const contextColor =
    contextPercent === undefined
      ? theme.muted
      : contextPercent >= 95
        ? theme.badge.error
        : contextPercent >= 80
          ? theme.badge.running
          : theme.muted;
  const [sidebarVisible, setSidebarVisible] = React.useState(terminalSize.columns >= 100);
  const [composerRows, setComposerRows] = React.useState(4);
  const [chatOffsetFromBottom, setChatOffsetFromBottom] = React.useState(0);
  const handleComposerRows = React.useCallback((rows: number) => setComposerRows(rows), []);
  const [escArmed, setEscArmed] = React.useState(false);
  const escTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const streaming = busy || Boolean(streamingText);

  React.useEffect(() => {
    if (!streaming) {
      setEscArmed(false);
      if (escTimerRef.current) clearTimeout(escTimerRef.current);
      escTimerRef.current = undefined;
    }
  }, [streaming]);

  React.useEffect(() => {
    return () => {
      if (escTimerRef.current) clearTimeout(escTimerRef.current);
    };
  }, []);

  const setMode = (next: AgentMode): void => {
    if (props.mode === undefined) setInternalMode(next);
    onModeChange(next);
  };

  const hasModalOpen =
    Boolean(props.pendingApproval) ||
    Boolean(props.pendingQuestion) ||
    helpOpen ||
    modelsOpen ||
    skillsOpen ||
    paletteOpen ||
    Boolean(sessionTab) ||
    hubOpen ||
    modePickerOpen ||
    reasoningPickerOpen;

  useInput((input, key) => {
    if (isMouseSequence(input)) return;
    if (key.escape) {
      if (hasModalOpen) return;
      if (!streaming || !onAbort) return;
      if (escArmed) {
        if (escTimerRef.current) clearTimeout(escTimerRef.current);
        escTimerRef.current = undefined;
        setEscArmed(false);
        onAbort();
        return;
      }
      setEscArmed(true);
      if (escTimerRef.current) clearTimeout(escTimerRef.current);
      escTimerRef.current = setTimeout(() => {
        escTimerRef.current = undefined;
        setEscArmed(false);
      }, 2500);
      return;
    }

    if (hasModalOpen) return;

    if ((key as { end?: boolean }).end) {
      setChatOffsetFromBottom(0);
      return;
    }

    if (escArmed) {
      if (escTimerRef.current) clearTimeout(escTimerRef.current);
      escTimerRef.current = undefined;
      setEscArmed(false);
    }

    if (key.ctrl && input === "b") {
      setSidebarVisible((prev) => !prev);
    }
  });

  const sidebarSubagents: SidebarSubagent[] = workers.map((worker) => ({
    id: worker.id,
    status: worker.status,
    task: worker.task,
  }));

  const innerWidth = Math.max(20, terminalSize.columns - 2);
  const chromeRows = 3 + (statusMessage || escArmed ? 1 : 0);
  const viewportHeight = computeViewportHeight(terminalSize.rows, chromeRows, composerRows);
  const chatScrollStep = Math.max(3, Math.floor(viewportHeight / 4));
  const { stdin } = useStdin();
  React.useEffect(() => {
    const onData = (data: Buffer): void => {
      const delta = parseMouseWheel(data.toString());
      if (delta === 0 || hasModalOpen) return;
      setChatOffsetFromBottom((previous) => Math.max(0, previous + delta * chatScrollStep));
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [hasModalOpen, chatScrollStep]);
  const showSidebar = sidebarVisible && innerWidth >= 60;
  const chatWidth = showSidebar ? Math.max(20, Math.floor(innerWidth * 0.72)) : innerWidth;
  const sidebarWidth = showSidebar ? Math.max(20, innerWidth - chatWidth) : 0;
  const divider = "─".repeat(innerWidth);

  const runCommand = (command: string): void => {
    onSubmit(command, { kind: "command", command, raw: command });
  };

  return (
    <ThemeProvider theme={props.currentTheme ?? "tokyonight"}>
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Box gap={1}>
            <OrchivoxLogo variant="compact" theme={theme} />
            <Text bold color={theme.text}>{projectName}</Text>
            <Text color={theme.muted}>· {branch}</Text>
          </Box>
          <Box gap={1}>
            <Text color={contextColor}>
              {formatContextUsage(contextTokens, modeCapabilities?.context_window)}
            </Text>
            <Text color={theme.muted}>·</Text>
            <Text color={theme.text}>{formatCost(totalCostUsd)}</Text>
          </Box>
        </Box>
        <Text color={theme.border.passive}>{divider}</Text>
        <Box gap={1}>
          <Text color={modePalette.primary}>●</Text>
          <Text bold color={modePalette.primary}>{mode.toUpperCase()}</Text>
          <Text color={theme.muted}>
            {MODE_HINTS[mode]}
            {modeModel ? ` · ${modeModel.provider} / ${modeModel.model}` : ""}
          </Text>
        </Box>

        {props.pendingApproval && props.onApprovalDecision ? (
          <ToolApprovalModal
            request={props.pendingApproval}
            onDecision={props.onApprovalDecision}
          />
        ) : props.pendingQuestion && props.onQuestionAnswer ? (
          <QuestionModal
            request={props.pendingQuestion}
            onAnswer={props.onQuestionAnswer}
            theme={theme}
          />
        ) : helpOpen ? (
          <HelpOverlay
            theme={theme}
            width={innerWidth}
            height={Math.max(10, terminalSize.rows - 8)}
            onClose={() => setHelpOpen(false)}
          />
        ) : modePickerOpen ? (
          <ChoiceModal
            title="Mode"
            subtitle={`Current: ${mode}`}
            options={MODE_CHOICES.map((choice) => ({
              id: choice.id,
              label: choice.label,
              description: choice.description,
              current: choice.id === mode,
            }))}
            initialIndex={Math.max(0, MODE_CHOICES.findIndex((choice) => choice.id === mode))}
            width={innerWidth}
            theme={theme}
            onSelect={(id) => {
              setMode(id as AgentMode);
              setModePickerOpen(false);
            }}
            onCancel={() => setModePickerOpen(false)}
          />
        ) : reasoningPickerOpen ? (
          <ChoiceModal
            title="Thinking effort"
            subtitle={`Current: ${props.reasoningEffort ?? "medium"}`}
            options={reasoningLevels.map((level) => ({
              id: level.id,
              label: level.label,
              description: level.description,
              current: level.id === (props.reasoningEffort ?? "medium"),
            }))}
            initialIndex={Math.max(
              0,
              reasoningLevels.findIndex(
                (level) => level.id === (props.reasoningEffort ?? "medium"),
              ),
            )}
            width={innerWidth}
            theme={theme}
            onSelect={(id) => {
              props.onReasoningEffortChange?.(id as ReasoningEffortLevel);
              setReasoningPickerOpen(false);
            }}
            onCancel={() => setReasoningPickerOpen(false)}
          />
        ) : skillsOpen ? (
          <SkillsModal
            skills={props.skills ?? []}
            activeSkills={props.activeSkills}
            width={innerWidth}
            theme={theme}
            onReload={props.onReloadSkills}
            onClose={() => setSkillsOpen(false)}
          />
        ) : modelsOpen && props.router ? (
          <ModelConfigModal
            router={props.router}
            configPath={configPath}
            secretsPath={secretsPath}
            theme={theme}
            initialView={modelsView}
            onClose={() => setModelsOpen(false)}
            onViewChange={setModelsView}
            onSaved={(message) => onStatusMessage?.(message)}
            onRoleChange={onRoleChange}
            onModeModelChange={props.onModeModelChange}
            onModeReasoningChange={props.onModeReasoningChange}
            reasoningEffort={props.reasoningEffort}
            onReasoningChange={props.onReasoningEffortChange}
          />
        ) : paletteOpen && props.router ? (
          <CommandPaletteModal
            router={props.router}
            currentTheme={props.currentTheme}
            reasoningEffort={props.reasoningEffort}
            reasoningLevels={reasoningOptions}
            onSelectTheme={props.onThemeChange}
            onSelectReasoning={props.onReasoningEffortChange}
            onOpenModels={() => {
              setModelsView("models");
              setModelsOpen(true);
            }}
            onAction={(action) => {
              if (action === "open_models") {
                setModelsView("models");
                setModelsOpen(true);
              } else if (action === "open_connect") {
                setModelsView("providers");
                setModelsOpen(true);
              } else if (action === "open_skills") {
                props.onReloadSkills?.();
                setSkillsOpen(true);
              } else if (action === "open_tasks") {
                setHubTab("tasks");
                setHubOpen(true);
              } else if (action === "open_hub") {
                setHubOpen(true);
              } else if (action === "open_sessions") {
                setSessionTab("sessions");
              } else if (action === "open_timeline") {
                setSessionTab("timeline");
              } else if (action === "open_fork") {
                setSessionTab("fork");
              } else if (action === "toggle_sidebar") {
                setSidebarVisible((prev) => !prev);
              } else if (action === "run_commit") {
                runCommand("/commit");
              } else if (action === "run_compact") {
                runCommand("/compact");
              } else if (action === "run_plugins") {
                runCommand("/plugins");
              }
            }}
            onClose={() => setPaletteOpen(false)}
          />
        ) : sessionTab && props.database && props.snapshots ? (
          <SessionTimeTravelModal
            database={props.database}
            snapshots={props.snapshots}
            activeSessionId={props.activeSessionId}
            activeSessionMessages={props.activeSessionMessages}
            initialTab={sessionTab}
            onResumeSession={props.onResumeSession}
            onForkSession={props.onForkSession}
            onNewSession={props.onNewSession}
            onSessionDeleted={props.onSessionDeleted}
            onRestoreSnapshot={props.onRestoreSnapshot}
            onClose={() => setSessionTab(null)}
          />
        ) : hubOpen ? (
          <AgentHub
            workers={workers}
            tasks={props.tasks ?? []}
            initialTab={hubTab}
            onTabChange={setHubTab}
            onSteer={(workerId, instruction) => onSteer(workerId, instruction)}
            onKill={onKill}
            onCancelTask={props.onCancelTask}
            onDispatchTasks={props.onDispatchTasks}
            onMergeTask={props.onMergeTask}
            onExit={() => setHubOpen(false)}
            width={innerWidth}
            theme={theme}
          />
        ) : (
          <Box width={innerWidth}>
            <Box width={chatWidth} flexDirection="column">
              <ScrollableChatViewport
                entries={entries}
                streamingText={streamingText}
                liveEntry={liveEntry}
                width={chatWidth}
                height={viewportHeight}
                theme={theme}
                initiallyCollapsed={false}
                active={!hasModalOpen}
                repoPath={globalThis.process.cwd()}
                branch={branch}
                resetKey={props.activeSessionId}
                offsetFromBottom={chatOffsetFromBottom}
                onOffsetChange={setChatOffsetFromBottom}
                topOffset={3}
              />
            </Box>
            {showSidebar ? (
              <Box width={sidebarWidth} flexDirection="column">
                <WorkspaceSidebar
                  todos={todos}
                  modifiedFiles={modifiedFiles}
                  lspStatus={lspStatus}
                  mcpServers={mcpServers}
                  subagents={sidebarSubagents}
                  theme={theme}
                />
              </Box>
            ) : null}
          </Box>
        )}

        {escArmed ? (
          <Text color={theme.badge.running}>Press Esc again to stop the current turn</Text>
        ) : statusMessage ? (
          <Text color={theme.modes.build.primary}>{statusMessage}</Text>
        ) : null}

        {!hasModalOpen ? (
          <PromptComposer
            mode={mode}
            theme={theme}
            width={innerWidth}
            streaming={streaming}
            onLayoutRows={handleComposerRows}
            onModeToggle={() => {
              const index = MODE_ORDER.indexOf(mode);
              setMode(MODE_ORDER[(index + 1) % MODE_ORDER.length]);
            }}
            onOpenHelp={() => setHelpOpen(true)}
            onOpenHub={() => setHubOpen(true)}
            onOpenPalette={() => setPaletteOpen(true)}
            onOpenSessions={() => setSessionTab("sessions")}
            onScrollLine={(delta) =>
              setChatOffsetFromBottom((value) => Math.max(0, value + delta * chatScrollStep))
            }
            onScrollPage={(delta) =>
              setChatOffsetFromBottom((value) => Math.max(0, value + delta * viewportHeight))
            }
            onScrollToBottom={() => setChatOffsetFromBottom(0)}
            onSubmit={(payload) => {
              setChatOffsetFromBottom(0);
              const action = interpretInput(payload.rawText);
              if (action.kind === "command") {
                if (action.command === "/help") {
                  setHelpOpen(true);
                  return;
                }
                if (action.command === "/mode" && (action.args ?? "").trim().length === 0) {
                  setModePickerOpen(true);
                  return;
                }
                if (action.command === "/reasoning" && (action.args ?? "").trim().length === 0) {
                  setReasoningPickerOpen(true);
                  return;
                }
                if (action.command === "/models") {
                  setModelsView("models");
                  setModelsOpen(true);
                  return;
                }
                if (action.command === "/connect") {
                  setModelsView("providers");
                  setModelsOpen(true);
                  return;
                }
                if (action.command === "/palette") {
                  setPaletteOpen(true);
                  return;
                }
                if (action.command === "/sessions") {
                  setSessionTab("sessions");
                  return;
                }
                if (action.command === "/fork") {
                  setSessionTab("fork");
                  return;
                }
                if (action.command === "/timeline") {
                  setSessionTab("timeline");
                  return;
                }
                if (action.command === "/hub") {
                  setHubTab("workers");
                  setHubOpen(true);
                  return;
                }
              }
              if (payload.ultrawork || (action.kind === "submit" && action.ultrawork)) {
                setMode("ultrawork");
              }
              if (payload.fullText.trim().length > 0) {
                onSubmit(payload.fullText.trim(), action, payload.attachments);
              }
            }}
          />
        ) : null}
      </Box>
    </ThemeProvider>
  );
}

export function renderOrchivoxApp(
  props: OrchivoxAppProps,
  options: { onFrame?: (frame: string) => void } = {},
): { uninstall: () => void } {
  const synced = installSynchronizedOutput({ frameMs: 16, onFrame: options.onFrame });
  const instance = render(<OrchivoxApp {...props} />);
  void instance.waitUntilExit().then(() => synced.uninstall());
  return { uninstall: () => synced.uninstall() };
}
