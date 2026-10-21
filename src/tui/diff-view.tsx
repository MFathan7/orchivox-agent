import { structuredPatch } from "diff";
import React from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";

import { toolDisplay } from "../agent/tool-display";
import { computeLineHash } from "../tools/hashline-edit";
import type { RenderRow } from "./rows";
import { displayWidth, expandTabs, fitDisplayText, wrapPreservingWhitespace } from "./text-wrap";
import type { ThinkingSegmentView } from "./app";
import { getTheme, type Theme } from "./theme";

const PANEL_PAD = " ";
const PANEL_END = "\u200b";

export interface DiffViewProps {
  oldText: string;
  newText: string;
  oldLabel?: string;
  newLabel?: string;
  unified?: boolean;
  context?: number;
  width?: number;
  theme?: Theme;
}

export interface ToolCallBadgeProps {
  name: string;
  label?: string;
  detail?: string;
  argumentsSummary: string;
  durationMs?: number;
  status?: "running" | "ok" | "error";
  lspStatus?: string;
  theme?: Theme;
}

export interface ThinkingBlockProps {
  text: string;
  defaultOpen?: boolean;
  focused?: boolean;
  live?: boolean;
  durationMs?: number;
  width?: number;
  theme?: Theme;
}

export function formatThinkingDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

interface DisplayLine {
  kind: "add" | "remove" | "context";
  oldNumber?: number;
  newNumber?: number;
  text: string;
}

interface DisplayHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DisplayLine[];
}

export function collectDiffHunks(oldText: string, newText: string, context = 3): DisplayHunk[] {
  const patch = structuredPatch("old", "new", oldText, newText, undefined, undefined, { context });
  return patch.hunks.map((hunk) => {
    let oldNumber = hunk.oldStart;
    let newNumber = hunk.newStart;
    const lines: DisplayLine[] = hunk.lines.map((raw) => {
      const marker = raw.charAt(0);
      const text = raw.slice(1);
      if (marker === "+") {
        return { kind: "add" as const, newNumber: newNumber++, text };
      }
      if (marker === "-") {
        return { kind: "remove" as const, oldNumber: oldNumber++, text };
      }
      return { kind: "context" as const, oldNumber: oldNumber++, newNumber: newNumber++, text };
    });
    return {
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines,
    };
  });
}

export function pairDiffLines(lines: DisplayLine[]): Array<{ left?: DisplayLine; right?: DisplayLine }> {
  const pairs: Array<{ left?: DisplayLine; right?: DisplayLine }> = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === "context") {
      pairs.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const removals: DisplayLine[] = [];
    const additions: DisplayLine[] = [];
    while (index < lines.length && lines[index].kind === "remove") removals.push(lines[index++]);
    while (index < lines.length && lines[index].kind === "add") additions.push(lines[index++]);
    const width = Math.max(removals.length, additions.length);
    for (let slot = 0; slot < width; slot += 1) {
      pairs.push({ left: removals[slot], right: additions[slot] });
    }
  }
  return pairs;
}

function lineHash(line: DisplayLine): string {
  return computeLineHash(line.text);
}

function unifiedLine(
  line: DisplayLine,
  showHash = true,
): { marker: string; kind: DisplayLine["kind"]; gutter: string } {
  const number = line.kind === "add" ? line.newNumber : line.oldNumber;
  const gutter = showHash
    ? `${String(number ?? "").padStart(4)} ${lineHash(line)}`
    : String(number ?? "").padStart(4);
  if (line.kind === "add") return { marker: "+", kind: "add", gutter };
  if (line.kind === "remove") return { marker: "-", kind: "remove", gutter };
  return { marker: " ", kind: "context", gutter };
}

function fitDiffText(text: string, width: number): string {
  const plain = expandTabs(text);
  const safeWidth = Math.max(1, width);
  if (displayWidth(plain) <= safeWidth) {
    return plain + " ".repeat(safeWidth - displayWidth(plain));
  }
  if (safeWidth <= 3) return plain.slice(0, safeWidth);
  let output = "";
  let used = 0;
  for (const char of plain) {
    const charWidth = displayWidth(char);
    if (used + charWidth > safeWidth - 3) break;
    output += char;
    used += charWidth;
  }
  return `${output}...`;
}

export function diffRows(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
  width: number,
  theme: Theme,
  unified = false,
  background?: string,
): RenderRow[] {
  const hunks = collectDiffHunks(oldText, newText);
  const rows: RenderRow[] = [];
  const sideBySide = !unified && width >= 100;
  const lineColor = (kind: DisplayLine["kind"]): string =>
    kind === "add" ? theme.diff.added : kind === "remove" ? theme.diff.removed : theme.muted;
  const panelRow = (
    key: string,
    node: React.ReactNode,
    plainInput: string,
  ): RenderRow => {
    const plain = fitDisplayText(plainInput, width);
    if (!background) return { key, node };
    return {
      key,
      node: (
        <Text backgroundColor={background} wrap="truncate">
          {displayWidth(plainInput) > width ? plain : node}
          {PANEL_PAD.repeat(Math.max(0, width - displayWidth(plain)))}
          {PANEL_END}
        </Text>
      ),
    };
  };

  const headerPlain = fitDisplayText(`${oldLabel} → ${newLabel}`, width);
  rows.push(
    panelRow(
      "diff-header",
      <Text bold color={theme.text} wrap="truncate">
        {headerPlain}
      </Text>,
      headerPlain,
    ),
  );

  hunks.forEach((hunk, hunkIndex) => {
    rows.push(
      panelRow(
        `diff-hunk-${hunkIndex}`,
        <Text color={theme.muted} wrap="truncate">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </Text>,
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ),
    );

    if (!sideBySide) {
      hunk.lines.forEach((line, lineIndex) => {
        const view = unifiedLine(line, width >= 60);
        const firstPrefix = `${view.marker} ${view.gutter}`;
        const prefixWidth = displayWidth(`▎ ${firstPrefix} `);
        const textWidth = Math.max(8, width - prefixWidth);
        wrapPreservingWhitespace(line.text, textWidth).forEach((chunk, chunkIndex) => {
          const prefix = chunkIndex === 0 ? firstPrefix : "  ";
          rows.push(
            panelRow(
              `diff-${hunkIndex}-${lineIndex}-${chunkIndex}`,
              <Text color={lineColor(view.kind)} wrap="truncate">
                <Text color={theme.border.passive}>▎ </Text>
                {prefix} {chunk}
              </Text>,
              `▎ ${prefix} ${chunk}`,
            ),
          );
        });
      });
      return;
    }

    const columnWidth = Math.max(12, Math.floor((width - 1) / 2));
    pairDiffLines(hunk.lines).forEach((pair, lineIndex) => {
      const left = pair.left
        ? `${String(pair.left.kind === "add" ? "" : (pair.left.oldNumber ?? "")).padStart(4)} ${lineHash(pair.left)} ${
            pair.left.kind === "remove" ? "-" : " "
          } ${expandTabs(pair.left.text)}`
        : "(empty)";
      const right = pair.right
        ? `${String(pair.right.kind === "remove" ? "" : (pair.right.newNumber ?? "")).padStart(4)} ${lineHash(pair.right)} ${
            pair.right.kind === "add" ? "+" : " "
          } ${expandTabs(pair.right.text)}`
        : "(empty)";
      const leftText = fitDiffText(left, columnWidth);
      const rightText = fitDiffText(right, columnWidth);
      rows.push(
        panelRow(
          `diff-pair-${hunkIndex}-${lineIndex}`,
          <Text wrap="truncate">
            <Text color={pair.left ? lineColor(pair.left.kind) : theme.muted}>
              {leftText}
            </Text>
            <Text color={theme.border.passive}>│</Text>
            <Text color={pair.right ? lineColor(pair.right.kind) : theme.muted}>
              {rightText}
            </Text>
          </Text>,
          `${leftText}│${rightText}`,
        ),
      );
    });
  });

  return rows;
}

export function DiffView({
  oldText,
  newText,
  oldLabel = "old",
  newLabel = "new",
  unified = false,
  context = 3,
  width = 80,
  theme = getTheme("tokyonight"),
}: DiffViewProps) {
  const hunks = React.useMemo(() => collectDiffHunks(oldText, newText, context), [oldText, newText, context]);
  const sideBySide = !unified && width >= 100;

  const lineColor = (kind: DisplayLine["kind"]): string =>
    kind === "add" ? theme.diff.added : kind === "remove" ? theme.diff.removed : theme.muted;

  return (
    <Box flexDirection="column">
      <Text bold color={theme.text}>
        {fitDisplayText(`${oldLabel} → ${newLabel}`, width)}
      </Text>
      {hunks.map((hunk, hunkIndex) => (
        <Box key={hunkIndex} flexDirection="column">
          <Text color={theme.muted}>
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </Text>
          {!sideBySide
            ? hunk.lines.flatMap((line, lineIndex) => {
                const view = unifiedLine(line, width >= 60);
                const firstPrefix = `${view.marker} ${view.gutter}`;
                const textWidth = Math.max(8, width - displayWidth(`▎ ${firstPrefix} `));
                return wrapPreservingWhitespace(line.text, textWidth).map((chunk, chunkIndex) => (
                  <Text key={`${lineIndex}-${chunkIndex}`} color={lineColor(view.kind)}>
                    <Text color={theme.border.passive}>▎ </Text>
                    {chunkIndex === 0 ? firstPrefix : "  "} {chunk}
                  </Text>
                ));
              })
            : pairDiffLines(hunk.lines).map((pair, lineIndex) => {
                const columnWidth = Math.max(12, Math.floor((width - 1) / 2));
                const left = pair.left
                  ? `${String(pair.left.kind === "add" ? "" : (pair.left.oldNumber ?? "")).padStart(4)} ${lineHash(pair.left)} ${
                      pair.left.kind === "remove" ? "-" : " "
                    } ${expandTabs(pair.left.text)}`
                  : "(empty)";
                const right = pair.right
                  ? `${String(pair.right.kind === "remove" ? "" : (pair.right.newNumber ?? "")).padStart(4)} ${lineHash(pair.right)} ${
                      pair.right.kind === "add" ? "+" : " "
                    } ${expandTabs(pair.right.text)}`
                  : "(empty)";
                return (
                  <Box key={lineIndex}>
                    <Box width="50%">
                      <Text color={pair.left ? lineColor(pair.left.kind) : theme.muted}>
                        {fitDiffText(left, columnWidth)}
                      </Text>
                    </Box>
                    <Box width="50%">
                      <Text color={pair.right ? lineColor(pair.right.kind) : theme.muted}>
                        {fitDiffText(right, columnWidth)}
                      </Text>
                    </Box>
                  </Box>
                );
              })}
        </Box>
      ))}
    </Box>
  );
}

export function ToolCallBadge({
  name,
  label,
  detail,
  durationMs,
  status = "ok",
  lspStatus,
  theme = getTheme("tokyonight"),
}: ToolCallBadgeProps) {
  const statusColor = status === "running" ? theme.badge.running : status === "error" ? theme.badge.error : theme.badge.ok;
  const statusIcon = status === "running" ? "●" : status === "error" ? "✖" : "✔";
  return (
    <Box gap={1} marginY={0}>
      <Text color={statusColor} bold>
        {statusIcon} {label ?? toolDisplay(name).label}
      </Text>
      {detail ? <Text color={theme.muted}>{detail}</Text> : null}
      {durationMs !== undefined ? <Text color={theme.muted}>{durationMs}ms</Text> : null}
      {lspStatus ? <Text color={theme.badge.running}>lsp:{lspStatus}</Text> : null}
    </Box>
  );
}

export interface ThinkingTimelineProps {
  segments: ThinkingSegmentView[];
  expanded?: boolean;
  live?: boolean;
  showHeader?: boolean;
  width?: number;
  theme?: Theme;
}

export function ThinkingTimeline({
  segments,
  expanded = false,
  live = false,
  showHeader = true,
  width = 80,
  theme = getTheme("tokyonight"),
}: ThinkingTimelineProps) {
  const visible = live ? segments.filter((segment) => segment.completedAt !== undefined) : segments;
  if (visible.length === 0) return null;
  const contentWidth = Math.max(8, width - 2);
  const totalDuration = visible.reduce(
    (total, segment) => total + Math.max(0, (segment.completedAt ?? Date.now()) - segment.startedAt),
    0,
  );
  const duration = totalDuration > 0 ? formatThinkingDuration(totalDuration) : undefined;
  const phaseCount = visible.length > 1 ? `${visible.length} phases` : undefined;

  if (!expanded) {
    if (!showHeader) return null;
    return (
      <Text color={theme.muted}>
        <Text color={theme.border.passive}>▎ </Text>
        <Text color={theme.badge.running} bold>Thought</Text>
        {duration ? <Text color={theme.muted}> · {duration}</Text> : null}
        {phaseCount ? <Text color={theme.muted}> · {phaseCount}</Text> : null}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      {showHeader ? (
        <Text color={theme.muted}>
          <Text color={theme.border.passive}>▎ </Text>
          <Text color={theme.badge.running} bold>Thought</Text>
          {duration ? <Text color={theme.muted}> · {duration}</Text> : null}
          {phaseCount ? <Text color={theme.muted}> · {phaseCount}</Text> : null}
        </Text>
      ) : null}
      {visible.map((segment, segmentIndex) => {
        const lines = segment.text
          .split("\n")
          .flatMap((line) => wrapPreservingWhitespace(line, contentWidth));
        if (lines.length === 0) return null;
        return (
          <Box key={segment.id} flexDirection="column">
            {segmentIndex > 0 ? <Text color={theme.border.passive}> </Text> : null}
            {lines.map((line, index) => (
              <Text key={`${segment.id}-${index}`} color={theme.muted}>
                <Text color={theme.border.passive}>▎ </Text>
                {line || " "}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

export function ThinkingBlock({
  text,
  defaultOpen = false,
  focused = false,
  live = false,
  durationMs,
  width = 80,
  theme = getTheme("tokyonight"),
}: ThinkingBlockProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  useInput(
    (input, key) => {
      if (key.return || input === " ") setOpen((value) => !value);
    },
    { isActive: focused },
  );
  const contentWidth = Math.max(8, width - 2);
  const lines = text
    .split("\n")
    .flatMap((line) => wrapPreservingWhitespace(line, contentWidth));
  const duration = durationMs !== undefined ? formatThinkingDuration(durationMs) : undefined;

  if (live) {
    return (
      <Text color={theme.muted}>
        <Text color={theme.border.passive}>▎ </Text>
        <Text color={theme.badge.running} bold>Thinking</Text>
        {duration ? <Text color={theme.muted}> · {duration}</Text> : null}
      </Text>
    );
  }

  if (!open) {
    return (
      <Text color={theme.muted}>
        <Text color={theme.border.passive}>▎ </Text>
        <Text color={theme.badge.running} bold>Thought</Text>
        {duration ? <Text color={theme.muted}> · {duration}</Text> : null}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>
        <Text color={theme.border.passive}>▎ </Text>
        <Text color={theme.badge.running} bold>Thought</Text>
        {duration ? <Text color={theme.muted}> · {duration}</Text> : null}
        {focused ? <Text color={theme.muted}> · Enter to collapse</Text> : null}
      </Text>
      {lines.map((line, index) => (
        <Text key={index} color={theme.muted}>
          <Text color={theme.border.passive}>▎ </Text>
          {line || " "}
        </Text>
      ))}
    </Box>
  );
}
