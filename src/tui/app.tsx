import React from "react";
import { Box, Text, render, useInput } from "ink";

import type { AgentMode, Message } from "../types/schema";
import type { SubagentWorkerState } from "../agent/subagent";
import type { ApprovalDecision, ApprovalRequest } from "../agent/permissions";
import type { ProviderRouter } from "../provider/router";
import type { MemoryDatabase, SessionRecord } from "../memory/sqlite";
import type { RestoreResult, SnapshotManager } from "../vcs/snapshot";
import { AgentHub } from "./agent-hub";
import { ToolApprovalModal } from "./approval-modal";
import { CommandPaletteModal, type ReasoningEffortLevel } from "./command-palette";
import { PromptComposer } from "./composer";
import { SessionTimeTravelModal, type SessionModalTab } from "./session-modal";
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
  name: string;
  argumentsSummary: string;
  durationMs?: number;
  status?: "running" | "ok" | "error";
  lspStatus?: string;
}

export interface ChatEntryView {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  thinking?: string;
  toolCalls?: ChatToolCallView[];
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
  mode?: AgentMode;
  onModeChange?: (mode: AgentMode) => void;
  onSubmit?: (text: string, action: InputAction) => void;
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
  onRestoreSnapshot?: (result: RestoreResult) => void;
  todos?: SidebarTodo[];
  modifiedFiles?: SidebarFile[];
  lspStatus?: string;
  mcpServers?: string[];
}

const MODE_ORDER: AgentMode[] = ["plan", "build", "ultrawork"];
const MODE_STYLES: Record<AgentMode, { label: string; color: string; accent: string }> = {
  plan: { label: "[PLAN / PROMETHEUS MODE]", color: "blue", accent: "magenta" },
  build: { label: "[BUILD MODE]", color: "green", accent: "green" },
  ultrawork: { label: "[ULTRAWORK MODE]", color: "yellow", accent: "red" },
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

export function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(4)}`;
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
    mcpCount = 0,
    pluginCount = 0,
    totalTokens = 0,
    totalCostUsd = 0,
    entries,
    streamingText,
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
  } = props;

  const [internalMode, setInternalMode] = React.useState<AgentMode>("build");
  const mode = props.mode ?? internalMode;
  const [hubOpen, setHubOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [sessionTab, setSessionTab] = React.useState<SessionModalTab | null>(null);
  const [sidebarVisible, setSidebarVisible] = React.useState(true);
  const [collapsed, setCollapsed] = React.useState(false);

  const terminalSize = useTerminalSize();
  const theme = getTheme(props.currentTheme ?? "tokyonight");

  const setMode = (next: AgentMode): void => {
    if (props.mode === undefined) setInternalMode(next);
    onModeChange(next);
  };

  const hasModalOpen = hubOpen || paletteOpen || Boolean(sessionTab) || Boolean(props.pendingApproval);

  useInput((input, key) => {
    // Esc: cancel active streaming or dismiss open modal
    if (key.escape) {
      if (streamingText && onAbort) {
        onAbort();
        return;
      }
      if (hubOpen) {
        setHubOpen(false);
        return;
      }
      if (paletteOpen) {
        setPaletteOpen(false);
        return;
      }
      if (sessionTab) {
        setSessionTab(null);
        return;
      }
      if (props.pendingApproval && props.onApprovalDecision) {
        props.onApprovalDecision({
          approved: false,
          choice: "deny",
          reason: "Cancelled by user via Esc",
        });
        return;
      }
      return;
    }

    if (hasModalOpen) return;

    // Tab: cycle through modes
    if (key.tab) {
      const index = MODE_ORDER.indexOf(mode);
      setMode(MODE_ORDER[(index + 1) % MODE_ORDER.length]);
      return;
    }

    // Ctrl+P: open command palette
    if (key.ctrl && input === "p") {
      setPaletteOpen(true);
      return;
    }

    // Ctrl+S: open session time-travel modal
    if (key.ctrl && input === "s") {
      setSessionTab("sessions");
      return;
    }

    // Alt+A: toggle agent hub
    if ((key.meta && input === "a") || input === "\u001ba") {
      setHubOpen(true);
      return;
    }

    // Ctrl+O: toggle collapse for tool calls & thinking blocks
    if (key.ctrl && input === "o") {
      setCollapsed((prev) => !prev);
      return;
    }

    // Ctrl+B: toggle workspace sidebar
    if (key.ctrl && input === "b") {
      setSidebarVisible((prev) => !prev);
      return;
    }
  });

  const style = MODE_STYLES[mode];

  const sidebarSubagents: SidebarSubagent[] = workers.map((w) => ({
    id: w.id,
    status: w.status,
    task: w.task,
  }));

  const totalWidth = terminalSize.columns;
  const viewportHeight = Math.max(10, terminalSize.rows - 10);
  const chatWidth = sidebarVisible ? Math.max(20, Math.floor(totalWidth * 0.72)) : totalWidth;
  const sidebarWidth = sidebarVisible ? Math.max(20, totalWidth - chatWidth) : 0;

  return (
    <ThemeProvider theme={props.currentTheme ?? "tokyonight"}>
      <Box flexDirection="column" borderStyle="round" borderColor={style.color} paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color={theme.text}>
            {projectName} | branch: {branch} | MCP: {mcpCount} | plugins: {pluginCount}
          </Text>
          <Text color={theme.text}>
            {totalTokens} tok | <Text color={theme.syntax.number}>{formatCost(totalCostUsd)}</Text>
          </Text>
        </Box>
        <Text bold color={style.color}>
          {style.label}
        </Text>

        {hubOpen ? (
          <AgentHub
            workers={workers}
            onSteer={(workerId, instruction) => onSteer(workerId, instruction)}
            onKill={onKill}
            onExit={() => setHubOpen(false)}
          />
        ) : props.pendingApproval && props.onApprovalDecision ? (
          <ToolApprovalModal
            request={props.pendingApproval}
            onDecision={props.onApprovalDecision}
          />
        ) : paletteOpen && props.router ? (
          <CommandPaletteModal
            router={props.router}
            currentTheme={props.currentTheme}
            reasoningEffort={props.reasoningEffort}
            onSelectTheme={props.onThemeChange}
            onSelectReasoning={props.onReasoningEffortChange}
            onAction={(action) => {
              if (action === "/commit" || action === "/compact" || action === "/plugins") {
                onSubmit(action, { kind: "command", command: action });
              } else if (action === "open_hub") {
                setHubOpen(true);
              } else if (action === "open_sessions") {
                setSessionTab("sessions");
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
            onRestoreSnapshot={props.onRestoreSnapshot}
            onClose={() => setSessionTab(null)}
          />
        ) : (
          <Box width={totalWidth}>
            <Box width={chatWidth} flexDirection="column">
              <ScrollableChatViewport
                entries={entries}
                streamingText={streamingText}
                width={chatWidth}
                height={viewportHeight}
                theme={theme}
                initiallyCollapsed={collapsed}
                active={!hasModalOpen}
              />
            </Box>
            {sidebarVisible ? (
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

        {!hasModalOpen ? (
          <PromptComposer
            mode={mode}
            theme={theme}
            onModeToggle={() => {
              const index = MODE_ORDER.indexOf(mode);
              setMode(MODE_ORDER[(index + 1) % MODE_ORDER.length]);
            }}
            onOpenHub={() => setHubOpen(true)}
            onOpenPalette={() => setPaletteOpen(true)}
            onOpenSessions={() => setSessionTab("sessions")}
            onSubmit={(payload) => {
              const action = interpretInput(payload.rawText);
              if (action.kind === "command") {
                if (action.command === "/palette" || action.command === "/model") {
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
              }
              if (payload.ultrawork || (action.kind === "submit" && action.ultrawork)) {
                setMode("ultrawork");
              }
              if (payload.fullText.trim().length > 0) {
                onSubmit(payload.fullText.trim(), action);
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
