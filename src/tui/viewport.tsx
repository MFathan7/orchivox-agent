import React from "react";
import { Box, Text, useInput } from "ink";

import type { ChatEntryView, WriteTarget } from "./app";
import { DiffView, ThinkingBlock, ToolCallBadge } from "./diff-view";
import { MarkdownView } from "./markdown";
import { getTheme, type Theme } from "./theme";

export interface ScreenSize {
  columns: number;
  rows: number;
}

export interface ScreenTarget extends WriteTarget {
  columns?: number;
  rows?: number;
  on?: (event: string, listener: () => void) => void;
  removeListener?: (event: string, listener: () => void) => void;
}

export interface SidebarTodo {
  id: string;
  task: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "low" | "medium" | "high" | "critical";
}

export interface SidebarFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface SidebarSubagent {
  id: string;
  status: string;
  task: string;
}

export interface WorkspaceSidebarProps {
  todos: SidebarTodo[];
  modifiedFiles: SidebarFile[];
  lspStatus: string;
  mcpServers: string[];
  subagents: SidebarSubagent[];
  theme?: Theme;
}

export interface ScrollableChatViewportProps {
  entries: ChatEntryView[];
  streamingText?: string;
  width: number;
  height: number;
  theme?: Theme;
  initiallyCollapsed?: boolean;
  active?: boolean;
}

export interface SplitPaneViewportProps extends ScrollableChatViewportProps {
  sidebar: Omit<WorkspaceSidebarProps, "theme">;
  initialSidebarVisible?: boolean;
}

export const AUTO_SCROLL_PAUSED = "[AUTO-SCROLL PAUSED - Tekan End / G untuk ke bawah]";

export class AlternateScreen {
  private readonly target: ScreenTarget;
  private readonly resizeListener: () => void;
  private readonly listeners = new Set<(size: ScreenSize) => void>();
  private entered = false;

  constructor(target?: ScreenTarget) {
    this.target = target ?? (process.stdout as unknown as ScreenTarget);
    this.resizeListener = () => {
      const size = this.size;
      for (const listener of this.listeners) listener(size);
    };
  }

  get size(): ScreenSize {
    return {
      columns: this.target.columns ?? 80,
      rows: this.target.rows ?? 24,
    };
  }

  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.target.write("\u001b[?1049h");
    this.target.on?.("resize", this.resizeListener);
  }

  exit(): void {
    if (!this.entered) return;
    this.entered = false;
    this.target.removeListener?.("resize", this.resizeListener);
    this.target.write("\u001b[?1049l");
  }

  onChange(listener: (size: ScreenSize) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function useTerminalSize(): ScreenSize {
  const [size, setSize] = React.useState<ScreenSize>(() => ({
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  }));
  React.useEffect(() => {
    const listener = (): void => {
      setSize({ columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 });
    };
    process.stdout.on("resize", listener);
    return () => {
      process.stdout.removeListener("resize", listener);
    };
  }, []);
  return size;
}

export function estimateEntryLines(entry: ChatEntryView, width: number, collapsed: boolean): number {
  const safeWidth = Math.max(width, 20);
  let lines = Math.max(1, Math.ceil(entry.text.length / safeWidth));
  if (entry.thinking) {
    lines += collapsed ? 1 : 1 + entry.thinking.split("\n").length;
  }
  lines += entry.toolCalls?.length ?? 0;
  if (entry.diff) lines += collapsed ? 1 : 10;
  return lines;
}

export function selectWindow(
  entries: ChatEntryView[],
  width: number,
  height: number,
  offsetFromBottom: number,
  collapsed: boolean,
): ChatEntryView[] {
  const selected: ChatEntryView[] = [];
  let budget = height + offsetFromBottom;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const cost = estimateEntryLines(entry, width, collapsed);
    if (budget <= 0) break;
    selected.unshift(entry);
    budget -= cost;
  }
  return selected;
}

export function formatProgressBar(done: number, total: number, width = 12): string {
  const ratio = total === 0 ? 0 : Math.min(1, done / total);
  const filled = Math.round(ratio * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${Math.round(ratio * 100)}% (${done}/${total})`;
}

export function ScrollableChatViewport({
  entries,
  streamingText,
  width,
  height,
  theme = getTheme("tokyonight"),
  initiallyCollapsed = false,
  active = true,
}: ScrollableChatViewportProps): React.ReactElement {
  const [offsetFromBottom, setOffsetFromBottom] = React.useState(0);
  const [collapsed, setCollapsed] = React.useState(initiallyCollapsed);
  const halfPage = Math.max(1, Math.floor(height / 2));

  useInput(
    (input, key) => {
      if (key.pageUp) {
        setOffsetFromBottom((value) => value + height);
        return;
      }
      if (key.pageDown) {
        setOffsetFromBottom((value) => Math.max(0, value - height));
        return;
      }
      if (key.ctrl && input === "u") {
        setOffsetFromBottom((value) => value + halfPage);
        return;
      }
      if (key.ctrl && input === "d") {
        setOffsetFromBottom((value) => Math.max(0, value - halfPage));
        return;
      }
      if (input === "G" || input === "\u001b[F" || input === "\u001bOF") {
        setOffsetFromBottom(0);
        return;
      }
      if (key.ctrl && input === "o") {
        setCollapsed((value) => !value);
      }
    },
    { isActive: active },
  );

  const visible = selectWindow(entries, width, height, offsetFromBottom, collapsed);

  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((entry) => (
          <Box key={entry.id} flexDirection="column">
            {entry.role === "user" ? (
              <Text color={theme.accent} bold>
                &gt; {entry.text}
              </Text>
            ) : entry.role === "system" ? (
              <Text color={theme.muted} italic>
                {entry.text}
              </Text>
            ) : (
              <MarkdownView content={entry.text} theme={theme} />
            )}
            {entry.thinking ? (
              <ThinkingBlock
                key={`${entry.id}-thinking-${collapsed ? "closed" : "open"}`}
                text={entry.thinking}
                defaultOpen={!collapsed}
              />
            ) : null}
            {(entry.toolCalls ?? []).map((call, index) => (
              <ToolCallBadge
                key={`${entry.id}-tool-${index}`}
                name={call.name}
                argumentsSummary={collapsed ? "" : call.argumentsSummary}
                durationMs={call.durationMs}
                status={call.status}
                lspStatus={call.lspStatus}
              />
            ))}
            {entry.diff ? (
              collapsed ? (
                <Text color={theme.muted}>
                  diff hidden: {entry.diff.oldLabel ?? "old"} -&gt; {entry.diff.newLabel ?? "new"} (Ctrl+O to expand)
                </Text>
              ) : (
                <DiffView
                  oldText={entry.diff.oldText}
                  newText={entry.diff.newText}
                  oldLabel={entry.diff.oldLabel}
                  newLabel={entry.diff.newLabel}
                  unified={entry.diff.unified ?? false}
                />
              )
            ) : null}
          </Box>
        ))}
        {streamingText ? (
          <Box flexDirection="column">
            <Text color={theme.badge.running} dimColor>
              ... streaming
            </Text>
            <MarkdownView content={streamingText} theme={theme} />
          </Box>
        ) : null}
      </Box>
      {offsetFromBottom > 0 ? (
        <Text color={theme.badge.running} bold>
          {AUTO_SCROLL_PAUSED}
        </Text>
      ) : null}
    </Box>
  );
}

export function WorkspaceSidebar({
  todos,
  modifiedFiles,
  lspStatus,
  mcpServers,
  subagents,
  theme = getTheme("tokyonight"),
}: WorkspaceSidebarProps): React.ReactElement {
  const done = todos.filter((todo) => todo.status === "completed").length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border.active} paddingX={1}>
      <Text bold color={theme.accent}>
        Workspace
      </Text>

      <Text bold>Todos</Text>
      <Text color={theme.modes.build.primary}>{formatProgressBar(done, todos.length)}</Text>
      {todos.length === 0 ? <Text color={theme.muted}>(none)</Text> : null}
      {todos.map((todo) => (
        <Text key={todo.id} color={todo.status === "completed" ? theme.muted : theme.text}>
          {todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[~]" : "[ ]"} {todo.task}
        </Text>
      ))}

      <Text bold>Modified files</Text>
      {modifiedFiles.length === 0 ? <Text color={theme.muted}>(none)</Text> : null}
      {modifiedFiles.map((file) => (
        <Text key={file.path}>
          <Text color={theme.diff.added}>+{file.additions}</Text>
          <Text color={theme.muted}> / </Text>
          <Text color={theme.diff.removed}>-{file.deletions}</Text>
          <Text> {file.path}</Text>
        </Text>
      ))}

      <Text bold>Servers</Text>
      <Text color={theme.muted}>lsp: {lspStatus}</Text>
      <Text color={theme.muted}>mcp: {mcpServers.length > 0 ? mcpServers.join(", ") : "none"}</Text>

      <Text bold>Subagents</Text>
      {subagents.length === 0 ? <Text color={theme.muted}>(none)</Text> : null}
      {subagents.map((subagent) => (
        <Text key={subagent.id} color={subagent.status === "running" ? theme.badge.running : theme.muted}>
          {subagent.id} [{subagent.status}] {subagent.task.slice(0, 24)}
        </Text>
      ))}
    </Box>
  );
}

export function SplitPaneViewport({
  entries,
  streamingText,
  width,
  height,
  theme = getTheme("tokyonight"),
  initiallyCollapsed = false,
  sidebar,
  initialSidebarVisible = true,
  active = true,
}: SplitPaneViewportProps): React.ReactElement {
  const [sidebarVisible, setSidebarVisible] = React.useState(initialSidebarVisible);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "b") setSidebarVisible((value) => !value);
    },
    { isActive: active },
  );

  const chatWidth = sidebarVisible ? Math.max(20, Math.floor(width * 0.7)) : width;
  return (
    <Box width={width}>
      <Box width={chatWidth} flexDirection="column">
        <ScrollableChatViewport
          entries={entries}
          streamingText={streamingText}
          width={chatWidth}
          height={height}
          theme={theme}
          initiallyCollapsed={initiallyCollapsed}
          active={active}
        />
      </Box>
      {sidebarVisible ? (
        <Box width={Math.max(20, width - chatWidth)} flexDirection="column">
          <WorkspaceSidebar {...sidebar} theme={theme} />
        </Box>
      ) : null}
    </Box>
  );
}
