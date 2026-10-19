import React from "react";
import { Box, Text, useInput, useStdin } from "ink";

import { toolDisplay } from "../agent/tool-display";
import type { ChatEntryView, WriteTarget } from "./app";
import { DiffView, ThinkingBlock, ToolCallBadge } from "./diff-view";
import { parseMouseClick } from "./mouse";
import { activityCalls, activitySummary, groupToolCalls } from "./tool-groups";
import { formatTokenCount } from "./format";
import { WelcomeBanner } from "./logo";
import { MarkdownView } from "./markdown";
import { getTheme, type Theme } from "./theme";
import { wrapText } from "./text-wrap";

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
    this.target.write("\u001b[?1049h\u001b[?1000h\u001b[?1006h");
    this.target.on?.("resize", this.resizeListener);
  }

  exit(): void {
    if (!this.entered) return;
    this.entered = false;
    this.target.removeListener?.("resize", this.resizeListener);
    this.target.write("\u001b[?1000l\u001b[?1006l\u001b[?1049l");
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

export function estimateEntryLines(
  entry: ChatEntryView,
  width: number,
  collapsed: boolean,
  expandedGroups: ReadonlySet<string> = new Set(),
  thinkingExpanded = false,
): number {
  const safeWidth = Math.max(width, 20);
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
  let lines = countWrappedLines(entry.text, safeWidth);
  if (entry.thinking) {
    const thinkingOpen = !entry.live && thinkingExpanded;
    lines += thinkingOpen
      ? 3 + countWrappedLines(entry.thinking, Math.max(1, safeWidth - 4))
      : 3;
  }
  const activity = groupToolCalls(entry.toolCalls);
  if (activity.total > 0) {
    lines += 1 + (expandedGroups.has(entry.id) ? activity.total : 0);
  }
  lines += activity.others.length;
  lines += (entry.files?.length ?? 0) * (collapsed ? 1 : 10);
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
  const safeWidth = Math.max(width, 20);
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
      const thinkingOpen = !entry.live && thinkingExpanded;
      const thinking = entry.thinking
        ? thinkingOpen
          ? 3 + countWrappedLines(entry.thinking, Math.max(1, safeWidth - 4))
          : 3
        : 0;
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
  offsetFromBottom: controlledOffset,
  onOffsetChange,
  topOffset = 0,
  initiallyExpandedActivity = false,
}: ScrollableChatViewportProps): React.ReactElement {
  const [internalOffset, setInternalOffset] = React.useState(0);
  const offsetFromBottom = controlledOffset ?? internalOffset;
  const setOffsetFromBottom = onOffsetChange ?? setInternalOffset;
  const [collapsed, setCollapsed] = React.useState(initiallyCollapsed);
  const [thinkingExpanded, setThinkingExpanded] = React.useState(false);
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
  const totalLines = allEntries.reduce(
    (sum, entry) => sum + estimateEntryLines(entry, width, collapsed, expandedGroups, thinkingExpanded),
    0,
  );
  const maxOffset = Math.max(0, totalLines - height);
  const effectiveOffset = Math.min(offsetFromBottom, maxOffset);

  React.useEffect(() => {
    if (offsetFromBottom > maxOffset) setOffsetFromBottom(maxOffset);
  }, [offsetFromBottom, maxOffset]);

  React.useEffect(() => {
    if (!active) return;
    const onData = (data: Buffer): void => {
      const click = parseMouseClick(data.toString());
      if (!click) return;
      const row = click.y - (topOffset + 1);
      if (row < 0 || row >= height) return;
      const target = findActivityRowAt(
        allEntries,
        width,
        height,
        effectiveOffset,
        collapsed,
        expandedGroups,
        row,
        thinkingExpanded,
      );
      if (!target) return;
      setExpandedGroups((previous) => {
        const next = new Set(previous);
        if (next.has(target.id)) next.delete(target.id);
        else next.add(target.id);
        return next;
      });
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [
    active,
    stdin,
    topOffset,
    height,
    width,
    effectiveOffset,
    collapsed,
    expandedGroups,
    thinkingExpanded,
    allEntries,
  ]);

  const visible = selectWindow(
    allEntries,
    width,
    height,
    effectiveOffset,
    collapsed,
    expandedGroups,
    thinkingExpanded,
  );

  React.useEffect(() => {
    setOffsetFromBottom(0);
  }, [resetKey]);

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
          const activity = groupToolCalls(entry.toolCalls);
          const liveText = entry.live
            ? entry.text.split("\n").slice(-Math.max(4, height - 4)).join("\n")
            : entry.text;
          return (
            <Box key={entry.id} flexDirection="column">
              {entry.live ? (
                <Box gap={1} marginY={0}>
                  <Text color={theme.badge.running} bold>{spinner}</Text>
                  <Text color={theme.text} bold>
                    {running
                      ? (running.label ?? toolDisplay(running.name).label)
                      : entry.text
                        ? "Writing"
                        : entry.thinking
                          ? "Thinking"
                          : "Working"}
                  </Text>
                  {elapsed > 0 ? <Text color={theme.muted}>{elapsed}s</Text> : null}
                  <Text color={theme.muted}>Esc twice to stop</Text>
                </Box>
              ) : null}
              {entry.role === "compaction" ? (
                <Box flexDirection="column" marginY={1}>
                  <Text color={theme.border.passive}>
                    {dividerLine(entry.compaction?.auto ? "auto compacted" : "compacted", width)}
                  </Text>
                  {entry.compaction?.status === "running" ? (
                    <Text color={theme.badge.running}>compacting...</Text>
                  ) : entry.text ? (
                    collapsed ? (
                      <Text color={theme.muted}>summary hidden (Ctrl+O to expand)</Text>
                    ) : (
                      <MarkdownView content={entry.text} theme={theme} />
                    )
                  ) : null}
                  {entry.compaction?.error ? (
                    <Text color={theme.badge.error}>{entry.compaction.error}</Text>
                  ) : null}
                  {entry.compaction && entry.compaction.status !== "running" ? (
                    <Text color={theme.border.passive}>
                      {dividerLine(
                        `${formatTokenCount(entry.compaction.beforeTokens)} -> ${formatTokenCount(entry.compaction.afterTokens)} tokens · ${entry.compaction.removedMessages} messages removed`,
                        width,
                      )}
                    </Text>
                  ) : null}
                </Box>
              ) : entry.role === "user" ? (
                <Box flexDirection="column" marginY={1}>
                  {wrapText(entry.text, Math.max(1, width - 2)).map((line, lineIndex) => (
                    <Box key={`${entry.id}-line-${lineIndex}`}>
                      <Text color={theme.accent} bold>
                        ▌{" "}
                      </Text>
                      <Text color={theme.text} bold>
                        {line || " "}
                      </Text>
                    </Box>
                  ))}
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
                  key={`${entry.id}-thinking-${thinkingExpanded ? "open" : "closed"}`}
                  text={entry.thinking}
                  defaultOpen={entry.live ? false : thinkingExpanded}
                  theme={theme}
                />
              ) : null}
              {activity.total > 0 ? (
                <Box flexDirection="column">
                  <Text>
                    <Text color={theme.muted}>
                      {expandedGroups.has(entry.id) ? "▾ " : "▸ "}
                    </Text>
                    <Text color={theme.text}>Activity: {activitySummary(activity)}</Text>
                  </Text>
                  {expandedGroups.has(entry.id)
                    ? activityCalls(activity).map((call, index) => (
                        <Box key={`${entry.id}-activity-${index}`} paddingLeft={2}>
                          <ToolCallBadge
                            name={call.name}
                            label={call.label}
                            detail={call.detail}
                            argumentsSummary={collapsed ? "" : call.argumentsSummary}
                            durationMs={call.durationMs}
                            status={call.status}
                            lspStatus={call.lspStatus}
                            theme={theme}
                          />
                        </Box>
                      ))
                    : null}
                </Box>
              ) : null}
              {activity.others.map((call, index) => (
                <ToolCallBadge
                  key={`${entry.id}-tool-${index}`}
                  name={call.name}
                  label={call.label}
                  detail={call.detail}
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
                <Box marginY={1} flexDirection="column">
                  <MarkdownView content={liveText} theme={theme} />
                  {!entry.live &&
                  (entry.mode || entry.model || entry.tokensPerSecond !== undefined) ? (
                    <Text color={theme.muted}>
                      {[
                        entry.mode?.toUpperCase(),
                        entry.model,
                        entry.tokensPerSecond !== undefined && Number.isFinite(entry.tokensPerSecond)
                          ? `${entry.tokensPerSecond.toFixed(1)} tok/s`
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  ) : null}
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
