import React from "react";
import { Box, Text, render, useInput } from "ink";

import type { AgentMode } from "../types/schema";
import type { SubagentWorkerState } from "../agent/subagent";
import { AgentHub } from "./agent-hub";
import { DiffView, ThinkingBlock, ToolCallBadge } from "./diff-view";

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
  | { kind: "command"; command: string }
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
  workers?: SubagentWorkerState[];
  onSteer?: (workerId: string, instruction: string) => void;
  onKill?: (workerId: string) => void;
}

const SLASH_COMMANDS = ["/undo", "/redo", "/commit", "/compact", "/plugins", "/collab", "/clear"];
const MODE_ORDER: AgentMode[] = ["plan", "build", "ultrawork"];
const MODE_STYLES: Record<AgentMode, { label: string; color: string; accent: string }> = {
  plan: { label: "[PLAN / PROMETHEUS MODE]", color: "blue", accent: "magenta" },
  build: { label: "[BUILD MODE]", color: "green", accent: "green" },
  ultrawork: { label: "[ULTRAWORK MODE]", color: "yellow", accent: "red" },
};

export function interpretInput(text: string): InputAction {
  const trimmed = text.trim();
  if (trimmed.startsWith("/")) {
    return { kind: "command", command: trimmed.split(/\s+/)[0] ?? trimmed };
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
  } = props;

  const [internalMode, setInternalMode] = React.useState<AgentMode>("build");
  const mode = props.mode ?? internalMode;
  const [draft, setDraft] = React.useState("");
  const [hubOpen, setHubOpen] = React.useState(false);

  const setMode = (next: AgentMode): void => {
    if (props.mode === undefined) setInternalMode(next);
    onModeChange(next);
  };

  useInput((input, key) => {
    if (hubOpen) return;
    if (key.tab) {
      const index = MODE_ORDER.indexOf(mode);
      setMode(MODE_ORDER[(index + 1) % MODE_ORDER.length]);
      return;
    }
    if ((key.meta && input === "a") || input === "\u001ba") {
      setHubOpen(true);
      return;
    }
    if (key.return) {
      const action = interpretInput(draft);
      if (action.kind === "submit" && action.ultrawork) setMode("ultrawork");
      if (draft.trim().length > 0) onSubmit(draft.trim(), action);
      setDraft("");
      return;
    }
    if (key.backspace || key.delete) {
      setDraft((value) => value.slice(0, -1));
      return;
    }
    if (key.escape) {
      setDraft("");
      return;
    }
    if (!key.ctrl && !key.meta && input.length > 0 && input >= " ") {
      setDraft((value) => value + input);
    }
  });

  const style = MODE_STYLES[mode];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={style.color} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>
          {projectName} | branch: {branch} | MCP: {mcpCount} | plugins: {pluginCount}
        </Text>
        <Text>
          {totalTokens} tok | <Text color="yellow">{formatCost(totalCostUsd)}</Text>
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
      ) : (
        <Box flexDirection="column">
          {entries.map((entry) => (
            <Box key={entry.id} flexDirection="column">
              {entry.role === "user" ? (
                <Text color="cyan" bold>
                  &gt; {entry.text}
                </Text>
              ) : (
                <Text>{entry.text}</Text>
              )}
              {entry.thinking ? <ThinkingBlock text={entry.thinking} /> : null}
              {(entry.toolCalls ?? []).map((call, index) => (
                <ToolCallBadge
                  key={`${entry.id}-tool-${index}`}
                  name={call.name}
                  argumentsSummary={call.argumentsSummary}
                  durationMs={call.durationMs}
                  status={call.status}
                  lspStatus={call.lspStatus}
                />
              ))}
              {entry.diff ? (
                <DiffView
                  oldText={entry.diff.oldText}
                  newText={entry.diff.newText}
                  oldLabel={entry.diff.oldLabel}
                  newLabel={entry.diff.newLabel}
                  unified={entry.diff.unified ?? false}
                />
              ) : null}
            </Box>
          ))}
          {streamingText ? (
            <Box flexDirection="column">
              <Text color={style.accent} dimColor>
                ... streaming
              </Text>
              <Text>{streamingText}</Text>
            </Box>
          ) : null}
        </Box>
      )}

      <Box>
        <Text color={style.accent} bold>
          &gt;{" "}
        </Text>
        <Text>
          {draft}_{" "}
        </Text>
      </Box>
      <Text dimColor>
        Tab: switch mode | Alt+A: agent hub | commands: {SLASH_COMMANDS.join(" ")} | Enter: send
      </Text>
    </Box>
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
