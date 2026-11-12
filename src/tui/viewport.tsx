import React from "react";
import { Box, Text, useInput, useStdin, useStdout } from "ink";

import type { ChatEntryView, WriteTarget } from "./app";
import { isMouseSequence, parseMouseClick, parseMousePointerEvents } from "./mouse";
import { groupToolCalls } from "./tool-groups";
import { WelcomeBanner } from "./logo";
import { markdownRows } from "./markdown";
import { enterTerminal, leaveTerminal } from "./terminal-protocol";
import { getTheme, useActiveTheme, type Theme } from "./theme";
import { displayWidth, fitDisplayText, wrapText } from "./text-wrap";
import { rowContent, type RenderRow } from "./rows";
import { copyTextToClipboard } from "./clipboard";
import { highlightSelection, selectedText, selectionRange, type SelectionPoint, type TextSelection } from "./text-selection";
import {
  buildTranscriptRows,
  TranscriptRowIndex,
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
  leftOffset?: number;
  platform?: NodeJS.Platform;
  onCopyText?: (text: string) => Promise<unknown> | void;
  onCopyError?: (error: Error) => void;
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

export function estimateEntryLines(
  entry: ChatEntryView,
  width: number,
  collapsed: boolean,
  expandedGroups: ReadonlySet<string> = new Set(),
  thinkingExpanded = false,
  diffExpanded = false,
): number {
  return buildTranscriptRows([entry], {
    width: Math.max(1, width),
    theme: getTheme("tokyonight"),
    collapsed,
    expandedGroups,
    thinkingExpanded,
    diffExpanded,
  }).length;
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
  const rows = buildTranscriptRows(entries, {
    width,
    theme: getTheme("tokyonight"),
    collapsed,
    expandedGroups,
    thinkingExpanded,
    diffExpanded,
  });
  const window = computeViewportWindow(rows.length, height, offsetFromBottom);
  const leadingRows = window.showIndicator ? 0 : Math.max(0, height - rows.length);
  const contentRow = clickRow - (window.showIndicator ? 1 : 0) - leadingRows;
  if (contentRow < 0 || contentRow >= window.contentHeight) return undefined;
  const target = rows[window.start + contentRow];
  return target?.clickable === "activity" ? entries.find((entry) => entry.id === target.entryId) : undefined;
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

export interface ScrollbarGeometry {
  thumbStart: number;
  thumbSize: number;
  travel: number;
  maxOffset: number;
}

export function computeScrollbar(rowCount: number, height: number, offset: number): ScrollbarGeometry | undefined {
  if (height < 1 || rowCount <= height) return undefined;
  const window = computeViewportWindow(rowCount, height, offset);
  const thumbSize = Math.max(1, Math.min(height, Math.floor(height * height / rowCount)));
  const travel = height - thumbSize;
  return {
    thumbStart: Math.round((1 - window.effectiveOffset / window.maxOffset) * travel),
    thumbSize,
    travel,
    maxOffset: window.maxOffset,
  };
}

export function scrollbarOffsetAtRow(bar: ScrollbarGeometry, row: number, grabOffset = Math.floor(bar.thumbSize / 2)): number {
  if (bar.travel <= 0) return 0;
  const start = Math.max(0, Math.min(bar.travel, row - grabOffset));
  return Math.round((1 - start / bar.travel) * bar.maxOffset);
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
  leftOffset = 0,
  platform = process.platform,
  onCopyText,
  onCopyError,
  initiallyExpandedActivity = false,
  initiallyExpandedThinking = false,
}: ScrollableChatViewportProps): React.ReactElement {
  const theme = useActiveTheme(themeProp);
  const [internalOffset, setInternalOffset] = React.useState(0);
  const offsetFromBottom = controlledOffset ?? internalOffset;
  const setOffsetFromBottom = onOffsetChange ?? setInternalOffset;
  const [collapsed, setCollapsed] = React.useState(initiallyCollapsed);
  const [detailsExpanded, setDetailsExpanded] = React.useState(initiallyExpandedActivity);
  const [thinkingExpanded, setThinkingExpanded] = React.useState(initiallyExpandedThinking);
  const diffExpanded = detailsExpanded;
  const contentWidth = Math.max(1, width - (width >= 3 ? 2 : 0));
  const dragGrabOffset = React.useRef<number | undefined>();
  type SelectionSnapshot = { rows: RenderRow[]; scrollbar?: ScrollbarGeometry; range: TextSelection };
  const [selection, setSelection] = React.useState<SelectionSnapshot>();
  const selectionDrag = React.useRef<(SelectionSnapshot & { moved: boolean; target?: TranscriptRow }) | undefined>();
  const copyQueue = React.useRef<Promise<unknown>>(Promise.resolve());
  const { stdout } = useStdout();
  const copyRef = React.useRef(onCopyText);
  copyRef.current = onCopyText ?? ((text) => copyTextToClipboard(text, { platform, isTTY: stdout.isTTY, write: (sequence) => stdout.write(sequence) }));
  const copyErrorRef = React.useRef(onCopyError);
  copyErrorRef.current = onCopyError;
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
      if (isMouseSequence(input)) return;
      if (selectionDrag.current) {
        selectionDrag.current = undefined;
        setSelection(undefined);
      }
      if (key.ctrl && input === "o") {
        const expand = !(thinkingExpanded || detailsExpanded);
        setThinkingExpanded(expand);
        setDetailsExpanded(expand);
        setCollapsed(false);
        setExpandedGroups(() => {
          if (!expand) return new Set();
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

  const rowOptions = React.useMemo(() => ({
    width: contentWidth,
    theme,
    collapsed,
    expandedGroups,
    thinkingExpanded,
    diffExpanded,
  }), [contentWidth, theme, collapsed, expandedGroups, thinkingExpanded, diffExpanded]);
  const history = React.useMemo(() => new TranscriptRowIndex(entries, rowOptions), [entries, rowOptions]);
  const rows: TranscriptRow[] = displayedLiveEntry ? buildTranscriptRows([displayedLiveEntry], rowOptions) : [];
  if (history.length > 0 && rows.length > 0 && displayedLiveEntry) {
    rows.unshift({
      key: `${displayedLiveEntry.id}-spacer`,
      entryId: displayedLiveEntry.id,
      node: <Text> </Text>,
    });
  }
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
      ...markdownRows(streamingText, contentWidth, theme).map((row, index) => ({
        ...row,
        key: `streaming-${index}`,
      })),
    );
  }

  const rowCount = history.length + rows.length;
  const window = computeViewportWindow(rowCount, height, offsetFromBottom);
  const scrollbar = width >= 3 ? computeScrollbar(rowCount, height, offsetFromBottom) : undefined;
  const scrollbarRef = React.useRef(scrollbar);
  scrollbarRef.current = scrollbar;
  const { start, contentHeight, maxOffset, showIndicator } = window;
  const end = start + contentHeight;
  const visibleRows = history.slice(start, end);
  if (end > history.length) {
    visibleRows.push(...rows.slice(Math.max(0, start - history.length), end - history.length));
  }
  const showWelcome = rowCount === 0 && !streamingText && !liveEntry;
  const leadingRows = showWelcome || showIndicator ? 0 : Math.max(0, height - visibleRows.length);
  const visibleRowsRef = React.useRef(visibleRows);
  visibleRowsRef.current = visibleRows;
  const screenRows: RenderRow[] = [
    ...(showIndicator ? [{ key: "scroll-paused", node: <Text color={theme.badge.running} bold>{fitDisplayText(AUTO_SCROLL_PAUSED, contentWidth)}</Text> }] : []),
    ...Array.from({ length: leadingRows }, (_, row) => ({ key: `leading-${row}`, node: <Text> </Text> })),
    ...visibleRows,
  ];
  const screenRowsRef = React.useRef(screenRows);
  screenRowsRef.current = screenRows;

  React.useEffect(() => {
    if (offsetFromBottom > maxOffset) setOffsetFromBottom(maxOffset);
  }, [offsetFromBottom, maxOffset]);

  React.useEffect(() => {
    if (!active) {
      dragGrabOffset.current = undefined;
      selectionDrag.current = undefined;
      setSelection(undefined);
      return;
    }
    const toggleActivity = (target?: TranscriptRow): void => {
      if (!target?.entryId || target.clickable !== "activity") return;
      const entryId = target.entryId;
      setExpandedGroups((previous) => {
        const next = new Set(previous);
        if (next.has(entryId)) next.delete(entryId);
        else next.add(entryId);
        return next;
      });
    };
    const onData = (data: Buffer): void => {
      const input = data.toString();
      let pointerHandled = false;
      for (const pointer of parseMousePointerEvents(input)) {
        if (pointer.type === "release") {
          pointerHandled ||= dragGrabOffset.current !== undefined;
          dragGrabOffset.current = undefined;
          const drag = selectionDrag.current;
          if (drag) {
            pointerHandled = true;
            selectionDrag.current = undefined;
            setSelection(undefined);
            const focus: SelectionPoint = {
              row: Math.max(0, Math.min(height - 1, pointer.y - topOffset - 1)),
              column: Math.max(0, Math.min(contentWidth - 1, pointer.x - leftOffset - 1)),
            };
            drag.range = { anchor: drag.range.anchor, focus };
            drag.moved ||= focus.row !== drag.range.anchor.row || focus.column !== drag.range.anchor.column;
            if (drag.moved) {
              const text = selectedText(drag.rows.map((row) => rowContent(row.node).text), drag.range, contentWidth);
              if (text.trim()) {
                const copy = copyRef.current!;
                copyQueue.current = copyQueue.current.catch(() => undefined).then(() => copy(text)).catch((error: unknown) => {
                  copyErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
                });
              }
            } else toggleActivity(drag.target);
          }
          continue;
        }
        const bar = scrollbarRef.current;
        const row = pointer.y - (topOffset + 1);
        if (pointer.type === "press") {
          dragGrabOffset.current = undefined;
          selectionDrag.current = undefined;
          setSelection(undefined);
          if (!bar || pointer.x !== leftOffset + width || row < 0 || row >= height) {
            if (platform !== "win32" && pointer.x > leftOffset && pointer.x <= leftOffset + contentWidth && row >= 0 && row < height) {
              const point: SelectionPoint = { row, column: pointer.x - leftOffset - 1 };
              const contentRow = row - (showIndicator ? 1 : 0) - leadingRows;
              selectionDrag.current = {
                rows: [...screenRowsRef.current], scrollbar: bar, range: { anchor: point, focus: point }, moved: false,
                target: visibleRowsRef.current[contentRow],
              };
              pointerHandled = true;
            }
            continue;
          }
          const onThumb = row >= bar.thumbStart && row < bar.thumbStart + bar.thumbSize;
          dragGrabOffset.current = onThumb ? row - bar.thumbStart : Math.floor(bar.thumbSize / 2);
          if (!onThumb) setOffsetFromBottom(scrollbarOffsetAtRow(bar, row, dragGrabOffset.current));
        } else {
          const drag = selectionDrag.current;
          if (drag) {
            const focus: SelectionPoint = { row: Math.max(0, Math.min(height - 1, row)), column: Math.max(0, Math.min(contentWidth - 1, pointer.x - leftOffset - 1)) };
            drag.range = { anchor: drag.range.anchor, focus };
            drag.moved ||= focus.row !== drag.range.anchor.row || focus.column !== drag.range.anchor.column;
            if (drag.moved) setSelection({ rows: drag.rows, scrollbar: drag.scrollbar, range: drag.range });
          } else {
            if (!bar || dragGrabOffset.current === undefined) continue;
            setOffsetFromBottom(scrollbarOffsetAtRow(bar, row, dragGrabOffset.current));
          }
        }
        pointerHandled = true;
      }
      if (pointerHandled) return;
      const click = parseMouseClick(input);
      if (!click) return;
      if (click.x <= leftOffset || click.x > leftOffset + contentWidth) return;
      const clickRow = click.y - (topOffset + 1);
      if (clickRow < 0 || clickRow >= height) return;
      const contentRow = clickRow - (showIndicator ? 1 : 0) - leadingRows;
      if (contentRow < 0) return;
      toggleActivity(visibleRowsRef.current[contentRow]);
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [active, stdin, topOffset, leftOffset, width, height, contentWidth, showIndicator, leadingRows, setOffsetFromBottom, platform]);

  React.useEffect(() => {
    selectionDrag.current = undefined;
    setSelection(undefined);
  }, [offsetFromBottom, width, height, resetKey, thinkingExpanded, detailsExpanded]);

  React.useEffect(() => {
    setOffsetFromBottom(0);
    dragGrabOffset.current = undefined;
    setDetailsExpanded(initiallyExpandedActivity);
    setThinkingExpanded(initiallyExpandedThinking);
  }, [resetKey]);

  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0} overflowY="hidden">
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
      {!showWelcome ? (selection?.rows ?? screenRows).map((row, index) => {
        const content = rowContent(row.node);
        const bar = selection ? selection.scrollbar : scrollbar;
        const thumb = bar && index >= bar.thumbStart && index < bar.thumbStart + bar.thumbSize;
        const range = selection ? selectionRange(selection.range, index, contentWidth) : undefined;
        return <Text key={row.key} wrap="truncate">
          {range ? highlightSelection(content.node, range.from, range.to, theme) : content.node}
          {bar ? <>{" ".repeat(Math.max(0, contentWidth - displayWidth(content.text)) + 1)}<Text color={thumb ? theme.text : theme.muted}>{thumb ? "█" : "│"}</Text></> : null}
        </Text>;
      }) : null}
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
