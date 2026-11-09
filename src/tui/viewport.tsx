import React from "react";
import { Box, Text, useInput, useStdin, useStdout } from "ink";

import type { ChatEntryView, ChatToolCallView, WriteTarget } from "./app";
import { DIFF_PREVIEW_LINES } from "./diff-view";
import { parseMouseClick } from "./mouse";
import { groupToolCalls } from "./tool-groups";
import { WelcomeBanner } from "./logo";
import { estimateMarkdownLines, markdownRows } from "./markdown";
import { enterTerminal, leaveTerminal } from "./terminal-protocol";
import { useActiveTheme, type Theme } from "./theme";
import { displayWidth, wrapText } from "./text-wrap";
import {
  LIVE_TOOL_LIMIT,
  buildTranscriptRows,
  liveDisplayText,
  type TranscriptRow,
} from "./transcript-lines";

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
  const { stdout } = useStdout();
  const [size, setSize] = React.useState<ScreenSize>(() => ({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  }));
  React.useEffect(() => {
    const listener = (): void => {
      setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    };
    stdout.on("resize", listener);
    return () => {
      stdout.removeListener("resize", listener);
    };
  }, [stdout]);
  return size;
}

export function countWrappedLines(text: string, width: number): number {
  const safeWidth = Math.max(1, width);
  if (text.length === 0) return 1;
  return text
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(displayWidth(line) / safeWidth)), 0);
}

/** Snapshot a live entry so pausing auto-scroll keeps the full text and tool history. */
export function freezeLiveEntry(entry: ChatEntryView): ChatEntryView {
  return {
    ...entry,
    frozenLive: true,
    toolCalls: entry.toolCalls?.map((call) => ({
      ...call,
      diff: call.diff ? { ...call.diff } : undefined,
    })),
    files: entry.files?.map((file) => ({ ...file })),
    thinkingSegments: entry.thinkingSegments?.map((segment) => ({ ...segment })),
  };
}

function estimateFileDiffLines(
  additions: number | undefined,
  deletions: number | undefined,
  collapsed: boolean,
  diffExpanded: boolean,
): number {
  if (collapsed) return 1;
  const changed = (additions ?? 0) + (deletions ?? 0);
  if (diffExpanded) return Math.max(2, changed + 2);
  return Math.min(changed, DIFF_PREVIEW_LINES) + (changed > DIFF_PREVIEW_LINES ? 1 : 0);
}

function estimateToolLines(
  call: ChatToolCallView,
  width: number,
  collapsed: boolean,
  diffExpanded = false,
): number {
  let lines = 4;
  const isCommand = Boolean(call.command) || ["shell", "bash", "run_sandbox_script", "execute", "bg_start", "bg_logs"].includes(call.name);
  if (isCommand && call.command) {
    lines += wrapText(call.command, Math.max(1, width - 4)).length;
  }
  if (call.output) {
    if (collapsed) {
      lines += 1;
    } else {
      const outputLines = call.output.split("\n").length;
      const visible = diffExpanded
        ? outputLines
        : Math.min(isCommand ? 24 : 14, outputLines);
      lines += visible + (outputLines > visible ? 1 : 0);
    }
  }
  if (call.diff) {
    if (collapsed) {
      lines += 1;
    } else if (diffExpanded) {
      lines += Math.max(2, (call.diff.additions ?? 0) + (call.diff.deletions ?? 0) + 6);
    } else {
      const changed = (call.diff.additions ?? 0) + (call.diff.deletions ?? 0);
      lines += Math.min(changed, DIFF_PREVIEW_LINES) + (changed > DIFF_PREVIEW_LINES ? 1 : 0);
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
  diffExpanded = false,
): number {
  const safeWidth = Math.max(1, width);
  const liveView = entry.live && !entry.frozenLive;
  if (entry.role === "compaction") {
    const header = 1;
    const footer = entry.compaction?.status === "running" ? 0 : 1;
    const body = collapsed ? 1 : countWrappedLines(entry.text, safeWidth);
    const error = entry.compaction?.error
      ? countWrappedLines(entry.compaction.error, safeWidth)
      : 0;
    return header + body + footer + error + 2;
  }
  if (entry.role === "user") {
    return wrapText(entry.text, Math.max(1, safeWidth - 2)).length + 2;
  }
  let lines =
    entry.role === "assistant"
      ? liveView
        ? (() => {
            const display = liveDisplayText(entry.text);
            return countWrappedLines(display.text, safeWidth) + (display.truncated ? 1 : 0);
          })()
        : estimateMarkdownLines(entry.text, safeWidth)
      : countWrappedLines(entry.text, safeWidth);
  if (entry.thinkingSegments && entry.thinkingSegments.length > 0) {
    const visibleSegments = liveView
      ? entry.thinkingSegments.filter((segment) => segment.completedAt !== undefined)
      : entry.thinkingSegments;
    if (visibleSegments.length > 0) {
      const textLines = visibleSegments.reduce(
        (total, segment) => total + countWrappedLines(segment.text, Math.max(1, safeWidth - 2)),
        0,
      );
      lines += thinkingExpanded ? 1 + textLines : 1;
    }
  } else if (entry.thinking && !liveView) {
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
  const calls = entry.toolCalls ?? [];
  const visibleCalls = liveView ? calls.slice(-LIVE_TOOL_LIMIT) : calls;
  lines += visibleCalls.reduce(
    (total, call) => total + estimateToolLines(call, safeWidth, collapsed, diffExpanded),
    0,
  );
  if (liveView && calls.length > LIVE_TOOL_LIMIT) lines += 1;
  const linkedPaths = new Set(
    (entry.toolCalls ?? [])
      .filter((call) => call.diff)
      .map((call) => call.filePath)
      .filter((path): path is string => Boolean(path)),
  );
  const unlinkedFiles = (entry.files ?? []).filter((file) => !linkedPaths.has(file.path));
  for (const file of unlinkedFiles) {
    lines += estimateFileDiffLines(file.additions, file.deletions, collapsed, diffExpanded);
  }
  if (liveView) lines += 1;
  if (entry.diff) lines += collapsed ? 1 : diffExpanded ? 10 : Math.min(DIFF_PREVIEW_LINES + 1, 10);
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
  diffExpanded = false,
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
    diffExpanded,
  );
  let row = 0;
  for (const entry of visible) {
    const liveView = entry.live && !entry.frozenLive;
    const activity = groupToolCalls(entry.toolCalls);
    if (entry.role === "assistant" && activity.total > 0) {
      let thinking = 0;
      if (entry.thinkingSegments && entry.thinkingSegments.length > 0) {
        const visibleSegments = liveView
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
      } else if (entry.thinking && !liveView) {
        thinking = thinkingExpanded
          ? 1 + countWrappedLines(entry.thinking, Math.max(1, safeWidth - 2))
          : 1;
      }
      const headerRow = row + (liveView ? 1 : 0) + thinking;
      if (Math.abs(clickRow - headerRow) <= 1) return entry;
    }
    row += estimateEntryLines(
      entry,
      width,
      collapsed,
      expandedGroups,
      thinkingExpanded,
      diffExpanded,
    );
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
  diffExpanded = false,
): ChatEntryView[] {
  const selected: ChatEntryView[] = [];
  let budget = height + offsetFromBottom;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const cost = estimateEntryLines(
      entry,
      width,
      collapsed,
      expandedGroups,
      thinkingExpanded,
      diffExpanded,
    );
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

export interface ViewportWindow {
  /** First row in the visible slice. */
  start: number;
  /** Rows available for content, excluding the paused banner when shown. */
  contentHeight: number;
  maxOffset: number;
  effectiveOffset: number;
  showIndicator: boolean;
}

/**
 * The paused banner takes one row. When it appears, the first offset must
 * still reveal one new row above it; otherwise the banner silently eats the
 * first scroll step.
 */
export function computeViewportWindow(
  rowCount: number,
  height: number,
  offsetFromBottom: number,
): ViewportWindow {
  const safeRows = Math.max(0, rowCount);
  const safeHeight = Math.max(1, height);

  if (safeHeight <= 1) {
    const maxOffset = Math.max(0, safeRows - 1);
    const effectiveOffset = Math.min(Math.max(0, offsetFromBottom), maxOffset);
    return {
      start: Math.max(0, safeRows - 1 - effectiveOffset),
      contentHeight: 1,
      maxOffset,
      effectiveOffset,
      showIndicator: false,
    };
  }

  const baseMaxOffset = Math.max(0, safeRows - safeHeight);
  const baseOffset = Math.min(Math.max(0, offsetFromBottom), baseMaxOffset);
  if (baseOffset <= 0) {
    return {
      start: Math.max(0, safeRows - safeHeight),
      contentHeight: safeHeight,
      maxOffset: baseMaxOffset,
      effectiveOffset: 0,
      showIndicator: false,
    };
  }

  const contentHeight = safeHeight - 1;
  const maxOffset = Math.max(0, safeRows - contentHeight - 1);
  const effectiveOffset = Math.min(Math.max(0, offsetFromBottom), maxOffset);
  if (effectiveOffset <= 0) {
    return {
      start: Math.max(0, safeRows - safeHeight),
      contentHeight: safeHeight,
      maxOffset: baseMaxOffset,
      effectiveOffset: 0,
      showIndicator: false,
    };
  }

  return {
    start: Math.max(0, safeRows - contentHeight - effectiveOffset - 1),
    contentHeight,
    maxOffset,
    effectiveOffset,
    showIndicator: true,
  };
}

export function formatProgressBar(done: number, total: number, width = 8): string {
  const ratio = total === 0 ? 0 : Math.min(1, done / total);
  const filled = Math.round(ratio * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${done}/${total}`;
}

export function ScrollableChatViewport({
  entries,
  streamingText,
  liveEntry,
  width,
  height,
  theme: themeProp,
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
  const theme = useActiveTheme(themeProp);
  const [internalOffset, setInternalOffset] = React.useState(0);
  const offsetFromBottom = controlledOffset ?? internalOffset;
  const setOffsetFromBottom = onOffsetChange ?? setInternalOffset;
  const [collapsed, setCollapsed] = React.useState(initiallyCollapsed);
  const [thinkingExpanded, setThinkingExpanded] = React.useState(initiallyExpandedThinking);
  const [diffExpanded, setDiffExpanded] = React.useState(false);
  const [frozenLiveEntry, setFrozenLiveEntry] = React.useState<ChatEntryView | undefined>();

  React.useEffect(() => {
    if (!liveEntry || offsetFromBottom <= 0) {
      if (frozenLiveEntry) setFrozenLiveEntry(undefined);
      return;
    }
    if (!frozenLiveEntry) setFrozenLiveEntry(freezeLiveEntry(liveEntry));
  }, [liveEntry, offsetFromBottom, frozenLiveEntry]);

  const displayedLiveEntry =
    offsetFromBottom > 0 && liveEntry && frozenLiveEntry ? frozenLiveEntry : liveEntry;
  const allEntries = React.useMemo(
    () => (displayedLiveEntry ? [...entries, displayedLiveEntry] : entries),
    [entries, displayedLiveEntry],
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
        setDiffExpanded((value) => !value);
        setThinkingExpanded((value) => !value);
        setCollapsed(false);
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

  const rows: TranscriptRow[] = buildTranscriptRows(allEntries, {
    width,
    theme,
    collapsed,
    expandedGroups,
    thinkingExpanded,
    diffExpanded,
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

  const window = computeViewportWindow(rows.length, height, offsetFromBottom);
  const { start, contentHeight, maxOffset, showIndicator } = window;
  const visibleRows = rows.slice(start, start + contentHeight);
  const hasChatMessages = allEntries.some((entry) => entry.role === "user" || entry.role === "assistant");
  const showWelcome = !hasChatMessages && !streamingText && !liveEntry;
  const leadingRows = showWelcome || showIndicator ? 0 : Math.max(0, height - visibleRows.length);
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
      const contentRow = clickRow - (showIndicator ? 1 : 0) - leadingRows;
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
  }, [active, stdin, topOffset, height, showIndicator, leadingRows]);

  React.useEffect(() => {
    setOffsetFromBottom(0);
    setDiffExpanded(false);
  }, [resetKey]);

  return (
    <Box flexDirection="column" height={height} flexShrink={0} overflowY="hidden">
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
      {leadingRows > 0 ? <Box height={leadingRows} flexShrink={0} /> : null}
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
  theme: themeProp,
}: WorkspaceSidebarProps): React.ReactElement {
  const theme = useActiveTheme(themeProp);
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

      <Text bold color={theme.text}>Todos</Text>
      <Text color={theme.status.success}>{formatProgressBar(done, todos.length)}</Text>
      {todos.length === 0 ? <Text color={theme.muted}>(none)</Text> : null}
      {todos.map((todo) => (
        <Text key={todo.id} color={todo.status === "completed" ? theme.muted : theme.text}>
          {todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[~]" : "[ ]"} {todo.task}
        </Text>
      ))}

      <Text bold color={theme.text}>Modified files</Text>
      {modifiedFiles.length === 0 ? <Text color={theme.muted}>(none)</Text> : null}
      {modifiedFiles.map((file) => (
        <Text key={file.path}>
          <Text color={theme.diff.added}>+{file.additions}</Text>
          <Text color={theme.muted}> / </Text>
          <Text color={theme.diff.removed}>-{file.deletions}</Text>
          <Text color={theme.text}> {file.path}</Text>
        </Text>
      ))}

      <Text bold color={theme.text}>Servers</Text>
      <Text color={theme.muted}>lsp: {lspStatus}</Text>
      <Text color={theme.muted}>mcp: {mcpServers.length > 0 ? mcpServers.join(", ") : "none"}</Text>

      <Text bold color={theme.text}>Subagents</Text>
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
  theme: themeProp,
  initiallyCollapsed = false,
  sidebar,
  initialSidebarVisible = true,
  active = true,
}: SplitPaneViewportProps): React.ReactElement {
  const theme = useActiveTheme(themeProp);
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
