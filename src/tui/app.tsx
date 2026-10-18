import React from "react";
import { Box, Text, render, useInput } from "ink";

import type { AgentMode, Message } from "../types/schema";
import type { SubagentWorkerState } from "../agent/subagent";
import type { SkillDocument } from "../agent/skills";
import type { TaskItem } from "../agent/task-board";
import type { ApprovalDecision, ApprovalRequest } from "../agent/permissions";
import type { ProviderRouter } from "../provider/router";
import type { MemoryDatabase, SessionRecord } from "../memory/sqlite";
import type { RestoreResult, SnapshotManager } from "../vcs/snapshot";
import type { ConfigRole } from "../config/writer";
import { AgentHub, type AgentHubTab } from "./agent-hub";
import { ToolApprovalModal } from "./approval-modal";
import { CommandPaletteModal, type ReasoningEffortLevel } from "./command-palette";
import { PromptComposer, type FileAttachmentRef } from "./composer";
import { HelpOverlay } from "./help-overlay";
import { OrchivoxLogo } from "./logo";
import { ModelConfigModal } from "./model-modal";
import { SessionTimeTravelModal, type SessionModalTab } from "./session-modal";
import { SkillsModal } from "./skills-modal";
import { formatCost, formatTokenCount } from "./format";
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

export interface ChatEntryView {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  thinking?: string;
  toolCalls?: ChatToolCallView[];
  files?: ChatFileChangeView[];
  live?: boolean;
  startedAt?: number;
  diff?: { oldText: string; newText: string; oldLabel?: string; newLabel?: string; unified?: boolean };
}

export interface OrchivoxAppProps {
  projectName?: string;
  branch?: string;
  mcpCount?: number;
  pluginCount?: number;
  totalTokens?: number;
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
  router?: ProviderRouter;
  database?: MemoryDatabase;
  snapshots?: SnapshotManager;
  activeSessionId?: string;
  activeSessionMessages?: Message[];
  currentTheme?: ThemeName;
  onThemeChange?: (theme: ThemeName) => void;
  reasoningEffort?: ReasoningEffortLevel;
  onReasoningEffortChange?: (effort: ReasoningEffortLevel) => void;
  onForkSession?: (forkedSession: SessionRecord) => void;
  onResumeSession?: (sessionId: string) => void;
  onNewSession?: () => void;
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
  onModelsOpenChange?: (open: boolean) => void;
  hubOpen?: boolean;
  onHubOpenChange?: (open: boolean) => void;
  hubTab?: AgentHubTab;
  onHubTabChange?: (tab: AgentHubTab) => void;
  tasks?: TaskItem[];
  onCancelTask?: (id: string) => void;
  onDispatchTasks?: () => void;
  onMergeTask?: (id: string) => void;
  skills?: SkillDocument[];
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
    totalTokens = 0,
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
  const [internalSkillsOpen, setInternalSkillsOpen] = React.useState(false);
  const [internalHubOpen, setInternalHubOpen] = React.useState(false);
  const [internalHubTab, setInternalHubTab] = React.useState<AgentHubTab>("workers");
  const [internalPaletteOpen, setInternalPaletteOpen] = React.useState(false);
  const [internalSessionTab, setInternalSessionTab] = React.useState<SessionModalTab | null>(null);

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
  const [sidebarVisible, setSidebarVisible] = React.useState(terminalSize.columns >= 100);
  const [composerRows, setComposerRows] = React.useState(4);
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
    Boolean(props.pendingApproval) || helpOpen || modelsOpen || skillsOpen || paletteOpen || Boolean(sessionTab) || hubOpen;

  useInput((input, key) => {
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
          <Text color={theme.muted}>
            {formatTokenCount(totalTokens)} tok · <Text color={theme.text}>{formatCost(totalCostUsd)}</Text>
          </Text>
        </Box>
        <Text color={theme.border.passive}>{divider}</Text>
        <Box gap={1}>
          <Text color={modePalette.primary}>●</Text>
          <Text bold color={modePalette.primary}>{mode.toUpperCase()}</Text>
          <Text color={theme.muted}>{MODE_HINTS[mode]}</Text>
        </Box>

        {props.pendingApproval && props.onApprovalDecision ? (
          <ToolApprovalModal
            request={props.pendingApproval}
            onDecision={props.onApprovalDecision}
          />
        ) : helpOpen ? (
          <HelpOverlay
            theme={theme}
            width={innerWidth}
            height={Math.max(10, terminalSize.rows - 8)}
            onClose={() => setHelpOpen(false)}
          />
        ) : skillsOpen ? (
          <SkillsModal
            skills={props.skills ?? []}
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
            onClose={() => setModelsOpen(false)}
            onSaved={(message) => onStatusMessage?.(message)}
            onRoleChange={onRoleChange}
          />
        ) : paletteOpen && props.router ? (
          <CommandPaletteModal
            router={props.router}
            currentTheme={props.currentTheme}
            reasoningEffort={props.reasoningEffort}
            onSelectTheme={props.onThemeChange}
            onSelectReasoning={props.onReasoningEffortChange}
            onOpenModels={() => setModelsOpen(true)}
            onAction={(action) => {
              if (action === "open_models") {
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
            onSubmit={(payload) => {
              const action = interpretInput(payload.rawText);
              if (action.kind === "command") {
                if (action.command === "/help") {
                  setHelpOpen(true);
                  return;
                }
                if (action.command === "/models") {
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
