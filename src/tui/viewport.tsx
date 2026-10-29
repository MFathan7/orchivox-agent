import React from "react";
import { Box, Text, useInput, useStdin } from "ink";

import type { ChatEntryView, ChatToolCallView, WriteTarget } from "./app";
import { parseMouseClick } from "./mouse";
import { groupToolCalls } from "./tool-groups";
import { WelcomeBanner } from "./logo";
import { estimateMarkdownLines, markdownRows } from "./markdown";
import { enterTerminal, leaveTerminal } from "./terminal-protocol";
import { getTheme, type Theme } from "./theme";
import { displayWidth, wrapText } from "./text-wrap";
import { buildTranscriptRows, type TranscriptRow } from "./transcript-lines";

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
  offsetFromBottom?: number;
  onOffsetChange?: React.Dispatch<React.SetStateAction<number>>;
  topOffset?: number;
  initiallyExpandedActivity?: boolean;
  initiallyExpandedThinking?: boolean;
}

export interface SplitPaneViewportProps extends ScrollableChatViewportProps {
  sidebar: Omit<WorkspaceSidebarProps, "theme">;
  initialSidebarVisible?: boolean;
}

export const AUTO_SCROLL_PAUSED = "AUTO-SCROLL PAUSED · Press End to jump to bottom";

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
    enterTerminal((chunk) => this.target.write(chunk));
    this.target.on?.("resize", this.resizeListener);
  }

  exit(): void {
    if (!this.entered) return;
    this.entered = false;
    this.target.removeListener?.("resize", this.resizeListener);
    leaveTerminal((chunk) => this.target.write(chunk));
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
    .reduce((total, line) => total + Math.max(1, Math.ceil(displayWidth(line) / safeWidth)), 0);
}

function estimateToolLines(
  call: ChatToolCallView,
  width: number,
  collapsed: boolean,
): number {
  let lines = 4;
  const isCommand = Boolean(call.command) || ["bash", "run_sandbox_script", "bg_start", "bg_logs"].includes(call.name);
  if (isCommand && call.command) {
    lines += wrapText(call.command, Math.max(1, width - 4)).length;
  }
  if (call.output) {
    if (collapsed) {
      lines += 1;
    } else {
      const outputLines = call.output.split("\n").length;
      const visible = Math.min(isCommand ? 24 : 14, outputLines);
      lines += visible + (outputLines > visible ? 1 : 0);
    }
  }
  if (call.diff) {
    if (collapsed) {
      lines += 1;
    } else {
      lines += Math.max(2, (call.diff.additions ?? 0) + (call.diff.deletions ?? 0) + 6);
    }
  }
  return lines;
}

export function estimateEntryLines(
  entry: ChatEntryView,
  width: number,
  collapsed: boolean,
  expandedGroups: ReadonlySet<string> = new Set(),
  thinkingExpanded = false,
): number {
  const safeWidth = Math.max(1, width);
  if (entry.role === "compaction") {
    const header = 1;
    const footer = entry.compaction?.status === "running" ? 0 : 1;
    const body = collapsed ? 1 : countWrappedLines(entry.text, safeWidth);
    const error = entry.compaction?.error ? 1 : 0;
    return header + body + footer + error + 2;
  }
  if (entry.role === "user") {
    return wrapText(entry.text, Math.max(1, safeWidth - 2)).length + 2;
  }
  let lines =
    entry.role === "assistant"
      ? estimateMarkdownLines(entry.text, safeWidth)
      : countWrappedLines(entry.text, safeWidth);
  if (entry.thinkingSegments && entry.thinkingSegments.length > 0) {
    const visibleSegments = entry.live
      ? entry.thinkingSegments.filter((segment) => segment.completedAt !== undefined)
      : entry.thinkingSegments;
    if (visibleSegments.length > 0) {
      const textLines = visibleSegments.reduce(
        (total, segment) => total + countWrappedLines(segment.text, Math.max(1, safeWidth - 2)),
        0,
      );
      lines += thinkingExpanded ? 1 + textLines : 1;
    }
  } else if (entry.thinking && !entry.live) {
    lines += thinkingExpanded ? 1 + countWrappedLines(entry.thinking, Math.max(1, safeWidth - 2)) : 1;
  }
  const hasThinkingContent =
    Boolean(entry.thinking) || (entry.thinkingSegments?.length ?? 0) > 0;
  const hasCompletedSegment = (entry.thinkingSegments ?? []).some(
    (segment) => segment.completedAt !== undefined,
  );
  const thinkingHeading =
    entry.role === "assistant" &&
    hasThinkingContent &&
    (!entry.live || entry.text.length > 0 || hasCompletedSegment);
  if (thinkingHeading) {
    lines += 1;
  }
  lines += (entry.toolCalls ?? []).reduce(
    (total, call) => total + estimateToolLines(call, safeWidth, collapsed),
    0,
  );
  const linkedPaths = new Set(
    (entry.toolCalls ?? [])
      .filter((call) => call.diff)
      .map((call) => call.filePath)
      .filter((path): path is string => Boolean(path)),
  );
  const unlinkedFiles = (entry.files ?? []).filter((file) => !linkedPaths.has(file.path));
  lines += unlinkedFiles.length * (collapsed ? 1 : 10);
  if (entry.live) lines += 1;
  if (entry.diff) lines += collapsed ? 1 : 10;
  if (entry.role === "assistant") lines += 2;
  if (
    entry.role === "assistant" &&
    entry.text &&
    !entry.live &&
    (entry.mode || entry.model || entry.tokensPerSecond !== undefined)
  ) {
    lines += 1;
  }
  return lines;
}

export function findActivityRowAt(
  entries: ChatEntryView[],
  width: number,
  height: number,
  offsetFromBottom: number,
  collapsed: boolean,
  expandedGroups: ReadonlySet<string>,
  clickRow: number,
  thinkingExpanded = false,
): ChatEntryView | undefined {
  const safeWidth = Math.max(1, width);
  const visible = selectWindow(
    entries,
    width,
    height,
    offsetFromBottom,
    collapsed,
    expandedGroups,
    thinkingExpanded,
  );
  let row = 0;
  for (const entry of visible) {
    const activity = groupToolCalls(entry.toolCalls);
    if (entry.role === "assistant" && activity.total > 0) {
      let thinking = 0;
      if (entry.thinkingSegments && entry.thinkingSegments.length > 0) {
        const visibleSegments = entry.live
          ? entry.thinkingSegments.filter((segment) => segment.completedAt !== undefined)
          : entry.thinkingSegments;
        if (visibleSegments.length > 0) {
          const textLines = visibleSegments.reduce(
            (total, segment) =>
              total + countWrappedLines(segment.text, Math.max(1, safeWidth - 2)),
            0,
          );
          thinking = thinkingExpanded ? 1 + textLines : 1;
        }
      } else if (entry.thinking && !entry.live) {
        thinking = thinkingExpanded
          ? 1 + countWrappedLines(entry.thinking, Math.max(1, safeWidth - 2))
          : 1;
      }
      const headerRow = row + (entry.live ? 1 : 0) + thinking;
      if (Math.abs(clickRow - headerRow) <= 1) return entry;
    }
    row += estimateEntryLines(entry, width, collapsed, expandedGroups, thinkingExpanded);
  }
  return undefined;
}

function dividerLine(label: string, width: number): string {
  const head = `── ${label} `;
  const safeWidth = Math.max(20, width);
  return `${head}${"─".repeat(Math.max(0, safeWidth - head.length))}`;
}

export function selectWindow(
  entries: ChatEntryView[],
  width: number,
  height: number,
  offsetFromBottom: number,
  collapsed: boolean,
  expandedGroups: ReadonlySet<string> = new Set(),
  thinkingExpanded = false,
): ChatEntryView[] {
  const selected: ChatEntryView[] = [];
  let budget = height + offsetFromBottom;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const cost = estimateEntryLines(entry, width, collapsed, expandedGroups, thinkingExpanded);
    if (budget <= 0) break;
    selected.unshift(entry);
    budget -= cost;
  }
  return selected;
}

export function transcriptAlignsToBottom(
  totalLines: number,
  height: number,
  offsetFromBottom: number,
): boolean {
  return offsetFromBottom <= 0 && totalLines > height;
}

export function formatProgressBar(done: number, total: number, width = 8): string {
  const ratio = total === 0 ? 0 : Math.min(1, done / total);
  const filled = Math.round(ratio * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${done}/${total}`;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function useSpinner(active: boolean): string {
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
  offsetFromBottom: controlledOffset,
  onOffsetChange,
  topOffset = 0,
  initiallyExpandedActivity = false,
  initiallyExpandedThinking = false,
}: ScrollableChatViewportProps): React.ReactElement {
  const [internalOffset, setInternalOffset] = React.useState(0);
  const offsetFromBottom = controlledOffset ?? internalOffset;
  const setOffsetFromBottom = onOffsetChange ?? setInternalOffset;
  const [collapsed, setCollapsed] = React.useState(initiallyCollapsed);
  const [thinkingExpanded, setThinkingExpanded] = React.useState(initiallyExpandedThinking);
  const allEntries = React.useMemo(
    () => (liveEntry ? [...entries, liveEntry] : entries),
    [entries, liveEntry],
  );
  const [expandedGroups, setExpandedGroups] = React.useState<Set<string>>(() => {
    if (!initiallyExpandedActivity) return new Set();
    return new Set(
      allEntries
        .filter((entry) => groupToolCalls(entry.toolCalls).total > 0)
        .map((entry) => entry.id),
    );
  });
  const { stdin } = useStdin();

  useInput(
    (input, key) => {
      if (key.ctrl && input === "o") {
        setCollapsed((value) => !value);
        setThinkingExpanded((value) => !value);
        setExpandedGroups((previous) => {
          if (previous.size > 0) return new Set();
          return new Set(
            allEntries
              .filter((entry) => groupToolCalls(entry.toolCalls).total > 0)
              .map((entry) => entry.id),
          );
        });
      }
    },
    { isActive: active },
  );

  const spinner = useSpinner(Boolean(liveEntry));
  const rows: TranscriptRow[] = buildTranscriptRows(allEntries, {
    width,
    theme,
    collapsed,
    expandedGroups,
    thinkingExpanded,
    spinner,
    now: Date.now(),
  });
  if (!liveEntry && streamingText) {
    rows.push({
      key: "streaming-header",
      node: (
        <Text color={theme.badge.running} dimColor>
          ... streaming
        </Text>
      ),
    });
    rows.push(
      ...markdownRows(streamingText, width, theme).map((row, index) => ({
        ...row,
        key: `streaming-${index}`,
      })),
    );
  }

  let availableHeight = Math.max(1, height);
  let maxOffset = Math.max(0, rows.length - availableHeight);
  let effectiveOffset = Math.min(offsetFromBottom, maxOffset);
  if (effectiveOffset > 0) {
    availableHeight = Math.max(0, height - 1);
    maxOffset = Math.max(0, rows.length - availableHeight);
    effectiveOffset = Math.min(offsetFromBottom, maxOffset);
  }
  const showIndicator = effectiveOffset > 0;
  const start = Math.max(0, rows.length - availableHeight - effectiveOffset);
  const visibleRows = rows.slice(start, start + availableHeight);
  const visibleRowsRef = React.useRef(visibleRows);
  visibleRowsRef.current = visibleRows;

  React.useEffect(() => {
    if (offsetFromBottom > maxOffset) setOffsetFromBottom(maxOffset);
  }, [offsetFromBottom, maxOffset]);

  React.useEffect(() => {
    if (!active) return;
    const onData = (data: Buffer): void => {
      const click = parseMouseClick(data.toString());
      if (!click) return;
      const clickRow = click.y - (topOffset + 1);
      if (clickRow < 0 || clickRow >= height) return;
      const contentRow = clickRow - (showIndicator ? 1 : 0);
      if (contentRow < 0) return;
      const target = visibleRowsRef.current[contentRow];
      const entryId = target?.entryId;
      if (!entryId || target?.clickable !== "activity") return;
      setExpandedGroups((previous) => {
        const next = new Set(previous);
        if (next.has(entryId)) next.delete(entryId);
        else next.add(entryId);
        return next;
      });
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [active, stdin, topOffset, height, showIndicator]);

  React.useEffect(() => {
    setOffsetFromBottom(0);
  }, [resetKey]);

  const hasChatMessages = allEntries.some((e) => e.role === "user" || e.role === "assistant");
  const showWelcome = !hasChatMessages && !streamingText && !liveEntry;

  return (
    <Box flexDirection="column" height={height} overflowY="hidden">
      {showWelcome ? (
        height >= 12 && width >= 100 ? (
          <WelcomeBanner theme={theme} repoPath={repoPath} branch={branch} />
        ) : (
          <Box justifyContent="center">
            <Text bold color={theme.accent}>ORCHIVOX</Text>
            <Text color={theme.muted}> · type a prompt to begin</Text>
          </Box>
        )
      ) : null}
      {showIndicator ? (
        <Text color={theme.badge.running} bold wrap="truncate">
          {AUTO_SCROLL_PAUSED}
        </Text>
      ) : null}
      {visibleRows.map((row) => (
        <React.Fragment key={row.key}>{row.node}</React.Fragment>
      ))}
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
