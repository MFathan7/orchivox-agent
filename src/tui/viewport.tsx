import React from "react";
import { Box, Text, useInput } from "ink";

import type { ChatEntryView, WriteTarget } from "./app";
import { DiffView, ThinkingBlock, ToolCallBadge } from "./diff-view";
import { WelcomeBanner } from "./logo";
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
  liveEntry?: ChatEntryView;
  width: number;
  height: number;
  theme?: Theme;
  initiallyCollapsed?: boolean;
  active?: boolean;
  repoPath?: string;
  branch?: string;
  resetKey?: string;
}

export interface SplitPaneViewportProps extends ScrollableChatViewportProps {
  sidebar: Omit<WorkspaceSidebarProps, "theme">;
  initialSidebarVisible?: boolean;
}

export const AUTO_SCROLL_PAUSED = "AUTO-SCROLL PAUSED · Press End / G to jump to bottom";

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

export function countWrappedLines(text: string, width: number): number {
  const safeWidth = Math.max(1, width);
  if (text.length === 0) return 1;
  return text
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / safeWidth)), 0);
}

export function estimateEntryLines(entry: ChatEntryView, width: number, collapsed: boolean): number {
  const safeWidth = Math.max(width, 20);
  let lines = countWrappedLines(entry.text, safeWidth);
  if (entry.thinking) {
    lines += collapsed ? 1 : 1 + countWrappedLines(entry.thinking, safeWidth - 2);
  }
  lines += entry.toolCalls?.length ?? 0;
  lines += (entry.files?.length ?? 0) * (collapsed ? 1 : 10);
  if (entry.live) lines += 1;
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

export function formatProgressBar(done: number, total: number, width = 8): string {
  const ratio = total === 0 ? 0 : Math.min(1, done / total);
  const filled = Math.round(ratio * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${done}/${total}`;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useSpinner(active: boolean): string {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    if (!active) {
      setFrame(0);
      return;
    }
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length), 110);
    return () => clearInterval(timer);
  }, [active]);
  return SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
}

export function ScrollableChatViewport({
  entries,
  streamingText,
  liveEntry,
  width,
  height,
  theme = getTheme("tokyonight"),
  initiallyCollapsed = false,
  active = true,
  repoPath,
  branch,
  resetKey,
}: ScrollableChatViewportProps): React.ReactElement {
  const [offsetFromBottom, setOffsetFromBottom] = React.useState(0);
  const [collapsed, setCollapsed] = React.useState(initiallyCollapsed);

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
      if (input === "\u001b[F" || input === "\u001bOF") {
        setOffsetFromBottom(0);
        return;
      }
      if (key.ctrl && input === "o") {
        setCollapsed((value) => !value);
      }
    },
    { isActive: active },
  );

  const spinner = useSpinner(Boolean(liveEntry));
  const allEntries = liveEntry ? [...entries, liveEntry] : entries;
  const visible = selectWindow(allEntries, width, height, offsetFromBottom, collapsed);

  React.useEffect(() => {
    setOffsetFromBottom(0);
  }, [entries.length, resetKey]);

  const hasChatMessages = allEntries.some((e) => e.role === "user" || e.role === "assistant");
  const showWelcome = !hasChatMessages && !streamingText && !liveEntry;

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {showWelcome ? (
          height >= 12 ? (
            <WelcomeBanner theme={theme} repoPath={repoPath} branch={branch} />
          ) : (
            <Box justifyContent="center">
              <Text bold color={theme.accent}>ORCHIVOX</Text>
              <Text color={theme.muted}> · type a prompt to begin</Text>
            </Box>
          )
        ) : null}
        {visible.map((entry) => {
          const running = entry.toolCalls?.find((call) => call.status === "running");
          const elapsed = entry.startedAt ? Math.max(0, Math.floor((Date.now() - entry.startedAt) / 1000)) : 0;
          const files = entry.live ? (entry.files ?? []).slice(-2) : (entry.files ?? []);
          const toolCalls = entry.live ? (entry.toolCalls ?? []).slice(-6) : (entry.toolCalls ?? []);
          const liveText = entry.live
            ? entry.text.split("\n").slice(-Math.max(4, height - 4)).join("\n")
            : entry.text;
          return (
            <Box key={entry.id} flexDirection="column">
              {entry.live ? (
                <Box gap={1} marginY={0}>
                  <Text color={theme.badge.running} bold>{spinner}</Text>
                  <Text color={theme.text} bold>
                    {running ? running.name : entry.text ? "writing" : entry.thinking ? "thinking" : "working"}
                  </Text>
                  {elapsed > 0 ? <Text color={theme.muted}>{elapsed}s</Text> : null}
                  <Text color={theme.muted}>Esc twice to stop</Text>
                </Box>
              ) : null}
              {entry.role === "user" ? (
                <Box marginY={0}>
                  <Text color={theme.accent} bold>
                    ❯ {entry.text}
                  </Text>
                </Box>
              ) : entry.role === "system" ? (
                <Box marginY={0} flexDirection="column">
                  {entry.text.split("\n").map((line, lineIndex) => (
                    <Text key={`${entry.id}-line-${lineIndex}`}>
                      <Text color={theme.modes.plan.primary}>{lineIndex === 0 ? "ℹ " : "  "}</Text>
                      <Text color={theme.text}>{line}</Text>
                    </Text>
                  ))}
                </Box>
              ) : null}
              {entry.thinking ? (
                <ThinkingBlock
                  key={`${entry.id}-thinking-${collapsed ? "closed" : "open"}`}
                  text={entry.thinking}
                  defaultOpen={entry.live ? false : !collapsed}
                  theme={theme}
                />
              ) : null}
              {toolCalls.map((call, index) => (
                <ToolCallBadge
                  key={`${entry.id}-tool-${index}`}
                  name={call.name}
                  argumentsSummary={collapsed ? "" : call.argumentsSummary}
                  durationMs={call.durationMs}
                  status={call.status}
                  lspStatus={call.lspStatus}
                  theme={theme}
                />
              ))}
              {files.map((file, index) => (
                <Box key={`${entry.id}-file-${index}`} flexDirection="column">
                  <Text color={theme.muted}>
                    {file.path}
                    {file.additions !== undefined || file.deletions !== undefined
                      ? ` (+${file.additions ?? 0} -${file.deletions ?? 0})`
                      : ""}
                  </Text>
                  {collapsed ? (
                    <Text color={theme.muted}>diff hidden (Ctrl+O to expand)</Text>
                  ) : (
                    <DiffView
                      oldText={file.oldText}
                      newText={file.newText}
                      oldLabel={`a/${file.path}`}
                      newLabel={`b/${file.path}`}
                      unified
                      theme={theme}
                    />
                  )}
                </Box>
              ))}
              {entry.diff ? (
                collapsed ? (
                  <Text color={theme.muted}>
                    diff hidden: {entry.diff.oldLabel ?? "old"} → {entry.diff.newLabel ?? "new"} (Ctrl+O to expand)
                  </Text>
                ) : (
                  <DiffView
                    oldText={entry.diff.oldText}
                    newText={entry.diff.newText}
                    oldLabel={entry.diff.oldLabel}
                    newLabel={entry.diff.newLabel}
                    unified={entry.diff.unified ?? false}
                    theme={theme}
                  />
                )
              ) : null}
              {entry.role === "assistant" && entry.text ? (
                <Box marginY={0} flexDirection="column">
                  <MarkdownView content={liveText} theme={theme} />
                </Box>
              ) : null}
            </Box>
          );
        })}
        {!liveEntry && streamingText ? (
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
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.border.passive}
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      paddingLeft={1}
    >
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
