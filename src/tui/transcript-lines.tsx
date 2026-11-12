import React from "react";
import { Box, Text } from "ink";

import { toolDisplay } from "../agent/tool-display";
import type { ChatEntryView, ChatToolCallView } from "./app";
import { diffPreviewRows, diffRows, formatThinkingDuration } from "./diff-view";
import { formatBytes, formatTokenCount, formatReplyDate } from "./format";
import { hashlinePanelParts, parseHashlineOutput } from "./hashline-format";
import { markdownRows } from "./markdown";
import { fitPanelParts, type PanelPart } from "./panel";
import type { RenderRow } from "./rows";
import { Spinner } from "./spinner";
import { ActivityText } from "./motion";
import { type Theme } from "./theme";
import {
  displayWidth,
  fitDisplayText,
  singleLine,
  wrapPreservingWhitespace,
  wrapText,
} from "./text-wrap";

export interface TranscriptRow extends RenderRow {
  entryId?: string;
  clickable?: "activity";
}

export interface BuildTranscriptOptions {
  width: number;
  theme: Theme;
  collapsed: boolean;
  expandedGroups: ReadonlySet<string>;
  thinkingExpanded: boolean;
  /** Show full edit/create diffs instead of the compact preview. */
  diffExpanded?: boolean;
  now?: number;
}

/** Keep auto-scroll live rendering bounded; scrolling up freezes the full entry. */
export const LIVE_TEXT_LIMIT = 12_000;
export const LIVE_TEXT_TAIL_LINES = 180;
export const LIVE_TOOL_LIMIT = 6;

export interface LiveDisplayText {
  text: string;
  truncated: boolean;
}

export function liveDisplayText(text: string): LiveDisplayText {
  const lines = text.split("\n");
  if (text.length <= LIVE_TEXT_LIMIT && lines.length <= LIVE_TEXT_TAIL_LINES) {
    return { text, truncated: false };
  }
  const tail = lines.slice(-LIVE_TEXT_TAIL_LINES).join("\n");
  if (tail.length <= LIVE_TEXT_LIMIT) {
    return { text: tail, truncated: true };
  }
  const cut = tail.slice(-LIVE_TEXT_LIMIT);
  const newline = cut.indexOf("\n");
  return {
    text: newline === -1 ? cut : cut.slice(newline + 1),
    truncated: true,
  };
}

export function visibleLiveToolCalls(entry: ChatEntryView): {
  calls: ChatToolCallView[];
  hidden: number;
} {
  const calls = entry.toolCalls ?? [];
  const liveView = entry.live && !entry.frozenLive;
  if (!liveView || calls.length <= LIVE_TOOL_LIMIT) {
    return { calls, hidden: 0 };
  }
  return {
    calls: calls.slice(-LIVE_TOOL_LIMIT),
    hidden: calls.length - LIVE_TOOL_LIMIT,
  };
}

export function toolOutputLines<T>(
  lines: T[],
  status: ChatToolCallView["status"],
  expanded: boolean,
): T[] {
  if (expanded) return lines;
  if (status === "error") {
    return lines.length <= 6 ? lines : [...lines.slice(0, 3), ...lines.slice(-3)];
  }
  return status === "running" ? lines.slice(-3) : lines.slice(0, 3);
}

function blankRow(key: string): TranscriptRow {
  return { key, node: <Text> </Text> };
}

function plainTextRows(
  text: string,
  width: number,
  theme: Theme,
  keyPrefix: string,
): TranscriptRow[] {
  const safeWidth = Math.max(8, width);
  return text.split("\n").flatMap((line, lineIndex) =>
    wrapPreservingWhitespace(line, safeWidth).map((chunk, chunkIndex) => ({
      key: `${keyPrefix}-${lineIndex}-${chunkIndex}`,
      node: (
        <Text wrap="truncate" color={theme.text}>
          {chunk.length > 0 ? chunk : " "}
        </Text>
      ),
    })),
  );
}

function dividerLine(label: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const center = fitDisplayText(` ${label} `, safeWidth);
  const remaining = Math.max(0, safeWidth - displayWidth(center));
  const left = Math.floor(remaining / 2);
  return `${"─".repeat(left)}${center}${"─".repeat(remaining - left)}`;
}

function statusIcon(status: ChatToolCallView["status"]): string {
  if (status === "running") return "●";
  return "○";
}

function statusColor(status: ChatToolCallView["status"], theme: Theme): string {
  if (status === "running") return theme.badge.running;
  if (status === "error") return theme.status.error;
  return status === "ok" ? theme.status.success : theme.muted;
}

const COMMAND_TOOL_NAMES = new Set(["shell", "bash", "run_sandbox_script", "execute", "bg_start", "bg_logs"]);
const HASHLINE_TOOL_NAMES = new Set(["read_file", "grep_search"]);
const EDIT_TOOL_NAMES = new Set([
  "hash_edit",
  "write_file",
  "create_file",
  "delete_file",
  "move_file",
  "apply_unified_patch",
]);

function editAction(call: ChatToolCallView): "edit" | "create" | "delete" | "move" {
  if (call.diff?.action) return call.diff.action;
  if (call.name === "create_file") return "create";
  if (call.name === "delete_file") return "delete";
  if (call.name === "move_file") return "move";
  return "edit";
}

function editActionLabel(action: "edit" | "create" | "delete" | "move"): string {
  if (action === "create") return "Create";
  if (action === "delete") return "Delete";
  if (action === "move") return "Move";
  return "Edit";
}

function toolCallRows(
  call: ChatToolCallView,
  width: number,
  collapsed: boolean,
  theme: Theme,
  keyPrefix: string,
  diffExpanded = false,
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const isCommand = COMMAND_TOOL_NAMES.has(call.name) || Boolean(call.command);
  const isEdit = EDIT_TOOL_NAMES.has(call.name) || Boolean(call.diff);
  const action = editAction(call);
  const label = isCommand
    ? "Run command"
    : isEdit
      ? editActionLabel(action)
      : call.label ?? toolDisplay(call.name).label;
  const command = isCommand ? call.command ?? call.detail ?? "" : "";
  const target = isCommand ? "" : singleLine(call.filePath ?? call.detail ?? "");
  const additions = call.diff?.additions;
  const deletions = call.diff?.deletions;
  const framed = width >= 12;
  const safeWidth = Math.max(1, width - (framed ? 4 : 0));
  const innerPad = framed ? 0 : Math.min(2, Math.max(0, safeWidth - 1));
  const bodyWidth = Math.max(1, safeWidth - innerPad);
  const statusTint = statusColor(call.status, theme);

  const inlineRow = (key: string, parts: PanelPart[], rowWidth = safeWidth): TranscriptRow => ({
    key,
    node: (
      <Text wrap="truncate" color={theme.text}>
        {fitPanelParts(parts, rowWidth).parts.map((part, index) => (
          <React.Fragment key={index}>
            {part.node ?? <Text color={part.color}>{part.text}</Text>}
          </React.Fragment>
        ))}
      </Text>
    ),
  });
  const indentedRows = (rows: RenderRow[], key: string): TranscriptRow[] =>
    rows.map((row, index) => ({
      ...row,
      key: `${key}-${index}`,
      node: (
        <Text wrap="truncate">
          {" ".repeat(innerPad)}
          {row.node}
        </Text>
      ),
    }));

  const icon = statusIcon(call.status);
  const suffixParts: PanelPart[] = [];
  if (additions !== undefined || deletions !== undefined) {
    suffixParts.push({
      text: ` +${additions ?? 0}`,
      node: <Text color={theme.diff.added}> +{additions ?? 0}</Text>,
      color: theme.diff.added,
    });
    suffixParts.push({
      text: ` -${deletions ?? 0}`,
      node: <Text color={theme.diff.removed}> -{deletions ?? 0}</Text>,
      color: theme.diff.removed,
    });
  }
  if (call.durationMs !== undefined) {
    suffixParts.push({
      text: ` ${formatThinkingDuration(call.durationMs)}`,
      node: <Text color={theme.muted}> {formatThinkingDuration(call.durationMs)}</Text>,
      color: theme.muted,
    });
  }
  if (call.lspStatus) {
    suffixParts.push({
      text: ` lsp:${call.lspStatus}`,
      node: <Text color={theme.muted}> lsp:{call.lspStatus}</Text>,
      color: theme.muted,
    });
  }

  const stateLabel = call.status === "error" ? "Error" : call.status === "ok" ? "Done" : call.status === "running" ? "Running" : "Pending";
  const headerWidth = Math.max(1, safeWidth - (framed ? 2 : 0));
  const fittedLabel = fitDisplayText(singleLine(label), Math.max(1, headerWidth - displayWidth(stateLabel) - 5));

  rows.push(
    inlineRow(keyPrefix, [
      {
        text: `${icon} `,
        node:
          call.status === "running" ? (
            <Spinner active color={statusTint} />
          ) : (
            <Text color={statusTint} bold>{icon} </Text>
          ),
        color: statusTint,
      },
      { text: fittedLabel, node: <Text bold>{fittedLabel}</Text> },
      { text: ` · ${stateLabel}`, node: <Text color={call.status === "running" ? theme.muted : statusTint}> · {stateLabel}</Text>, color: statusTint },
    ], headerWidth),
  );

  if (target) {
    const targetLabel = call.filePath ? "File" : "Target";
    wrapPreservingWhitespace(`${targetLabel}: ${target}`, bodyWidth).forEach((line, index) => {
      rows.push(inlineRow(`${keyPrefix}-target-${index}`, [
        { text: " ".repeat(innerPad) },
        { text: line, color: theme.text },
      ]));
    });
  }

  if (command) {
    wrapPreservingWhitespace(command, Math.max(1, bodyWidth - 2)).forEach(
      (line, index) => {
        const prompt = index === 0 ? "$ " : "  ";
        rows.push(
          inlineRow(`${keyPrefix}-command-${index}`, [
            { text: " ".repeat(innerPad) },
            {
              text: prompt,
              node: <Text color={theme.accent} bold>{prompt}</Text>,
              color: theme.accent,
            },
            { text: line, node: <Text color={theme.text}>{line}</Text>, color: theme.text },
          ]),
        );
      },
    );
  }

  if (call.output) {
    if (rows.length > 1) rows.push(blankRow(`${keyPrefix}-output-gap`));
    rows.push(inlineRow(`${keyPrefix}-output-label`, [
      { text: `${" ".repeat(innerPad)}Output`, color: theme.muted },
    ]));
    const outputTint = call.status === "error" ? theme.status.error : theme.muted;
    if (collapsed && call.status !== "error") {
      const plain = `${" ".repeat(innerPad)}output hidden (Ctrl+O to expand)`;
      rows.push(
        inlineRow(`${keyPrefix}-output-hidden`, [
          { text: plain, node: <Text color={theme.muted}>{plain}</Text>, color: theme.muted },
        ]),
      );
    } else {
      const anchored = HASHLINE_TOOL_NAMES.has(call.name)
        ? parseHashlineOutput(call.output)
        : undefined;
      const outputRows: Array<{ key: string; parts: PanelPart[] }> = [];
      if (anchored) {
        hashlinePanelParts(anchored.lines, { panelWidth: safeWidth, innerPad, theme }).forEach(
          (parts, index) => {
            outputRows.push({ key: `${keyPrefix}-output-anchored-${index}`, parts });
          },
        );
        if (anchored.notice) {
          wrapPreservingWhitespace(anchored.notice, bodyWidth).forEach((line, index) => {
            const plain = `${" ".repeat(innerPad)}${line}`;
            outputRows.push({ key: `${keyPrefix}-output-notice-${index}`, parts: [
              { text: plain, color: theme.muted },
            ] });
          });
        }
      } else {
        wrapPreservingWhitespace(call.output, bodyWidth).forEach((chunk, rowIndex) => {
          outputRows.push({ key: `${keyPrefix}-output-${rowIndex}`, parts: [
            { text: " ".repeat(innerPad) },
            { text: chunk || " ", color: outputTint },
          ] });
        });
      }
      const visible = toolOutputLines(outputRows, call.status, diffExpanded);
      const visibleRows = visible.map((row) => inlineRow(row.key, row.parts));
      const hidden = outputRows.length - visible.length;
      if (hidden > 0) {
        const plain = `${" ".repeat(innerPad)}… ${hidden} more row${hidden === 1 ? "" : "s"} · Ctrl+O to expand`;
        const hint = inlineRow(`${keyPrefix}-output-more`, [
          { text: plain, node: <Text color={theme.muted}>{plain}</Text>, color: theme.muted },
        ]);
        if (call.status === "running") visibleRows.unshift(hint);
        else if (call.status === "error") visibleRows.splice(3, 0, hint);
        else visibleRows.push(hint);
      }
      rows.push(...visibleRows);
    }
  }

  if (call.diff) {
    if (collapsed) {
      const plain = `${" ".repeat(innerPad)}diff hidden (Ctrl+O to expand)`;
      rows.push(
        inlineRow(`${keyPrefix}-diff-hidden`, [
          { text: plain, node: <Text color={theme.muted}>{plain}</Text>, color: theme.muted },
        ]),
      );
    } else {
      const rendered = diffExpanded
        ? diffRows(
            call.diff.oldText,
            call.diff.newText,
            call.diff.oldLabel ?? `a/${target ?? "file"}`,
            call.diff.newLabel ?? `b/${target ?? "file"}`,
            bodyWidth,
            theme,
            true,
            undefined,
            { showFileHeader: action === "move" },
          )
        : diffPreviewRows(
            call.diff.oldText,
            call.diff.newText,
            bodyWidth,
            theme,
          );
      if (rendered.length > 0) {
        if (rows.length > 1) rows.push(blankRow(`${keyPrefix}-diff-gap`));
        rows.push(inlineRow(`${keyPrefix}-diff-label`, [
          { text: `${" ".repeat(innerPad)}Changes`, color: theme.muted },
        ]));
        rows.push(...indentedRows(rendered, `${keyPrefix}-diff`));
      }
    }
  }

  if (!framed) return rows;
  const [header, ...body] = rows;
  const headerRuleWidth = Math.max(0, headerWidth - displayWidth(`${icon} ${fittedLabel} · ${stateLabel}`));
  const footerRuleWidth = Math.max(0, headerWidth - suffixParts.reduce((sum, part) => sum + displayWidth(part.text), 0));
  const rule = (length: number) => length > 0 ? ` ${"─".repeat(length - 1)}` : "";
  const framedRows: TranscriptRow[] = [{
    ...header,
    node: <Box height={1} flexShrink={0}>
      <Text color={theme.muted}>┌─ </Text>
      <Box width={headerWidth} height={1} flexShrink={0}>
        {header.node}<Text color={theme.muted}>{rule(headerRuleWidth)}</Text>
      </Box>
      <Text color={theme.muted}>──┐</Text>
    </Box>,
  }];
  for (const row of body) {
    framedRows.push({
      ...row,
      node: <Box height={1} flexShrink={0}>
        <Text color={theme.muted}>│ </Text>
        <Box width={safeWidth} height={1} flexShrink={0}>{row.node}</Box>
        <Text color={theme.muted}> │</Text>
      </Box>,
    });
  }
  framedRows.push({
    key: `${keyPrefix}-footer`,
    node: suffixParts.length > 0
      ? <Box height={1} flexShrink={0}>
          <Text color={theme.muted}>└─ </Text>
          <Box width={headerWidth} height={1} flexShrink={0}>
            {inlineRow(`${keyPrefix}-meta`, suffixParts, headerWidth).node}
            <Text color={theme.muted}>{rule(footerRuleWidth)}</Text>
          </Box>
          <Text color={theme.muted}>──┘</Text>
        </Box>
      : <Text color={theme.muted} wrap="truncate">└{"─".repeat(Math.max(0, width - 2))}┘</Text>,
  });
  return framedRows;
}

function thinkingTextRows(
  text: string,
  width: number,
  theme: Theme,
  keyPrefix: string,
): TranscriptRow[] {
  return text
    .split("\n")
    .flatMap((line) => wrapPreservingWhitespace(line, Math.max(1, width - 2)))
    .map((line, index) => ({
      key: `${keyPrefix}-${index}`,
      node: (
        <Text color={theme.muted} wrap="truncate">
          {"  "}
          {line || " "}
        </Text>
      ),
    }));
}

function thinkingHeaderRow(
  durationMs: number | undefined,
  phaseCount: number,
  theme: Theme,
  key: string,
): TranscriptRow {
  return {
    key,
    node: (
      <Text color={theme.muted} wrap="truncate">
        <Text bold>
          Thought
        </Text>
        {durationMs !== undefined && durationMs > 0 ? (
          <Text color={theme.muted}> · {formatThinkingDuration(durationMs)}</Text>
        ) : null}
        {phaseCount > 1 ? <Text color={theme.muted}> · {phaseCount} phases</Text> : null}
      </Text>
    ),
  };
}

function compactionRows(
  entry: ChatEntryView,
  width: number,
  expanded: boolean,
  theme: Theme,
): TranscriptRow[] {
  const running = entry.compaction?.status === "running";
  const label =
    running ? "Compacting" : entry.compaction?.status === "error" ? "Compaction failed" : "Compacted";
  const rows: TranscriptRow[] = [
    {
      key: `${entry.id}-divider`,
      node: (
        <Text color={theme.muted} wrap="truncate">
          {running ? <ActivityText text={dividerLine(label, width)} /> : dividerLine(label, width)}
        </Text>
      ),
    },
  ];

  if (!running && entry.compaction && entry.compaction.status !== "error") {
    const result = `${formatTokenCount(entry.compaction.beforeTokens)} → ${formatTokenCount(entry.compaction.afterTokens)} tokens · ${entry.compaction.removedMessages} messages compacted`;
    rows.push(...wrapText(result, Math.max(1, width)).map((line, index) => ({
      key: `${entry.id}-result-${index}`,
      node: <Text color={theme.muted} wrap="truncate">{line}</Text>,
    })));
  }

  if (!running && entry.text) {
    rows.push(
      ...markdownRows(entry.text, width, theme).map((row, index) => ({
        ...row,
        key: `${entry.id}-summary-${index}`,
      })),
    );
  }

  if (entry.compaction?.error) {
    rows.push(
      ...wrapPreservingWhitespace(entry.compaction.error, Math.max(8, width)).map(
        (line, index) => ({
          key: `${entry.id}-error-${index}`,
          node: (
            <Text color={theme.status.error} wrap="truncate">
              {line || " "}
            </Text>
          ),
        }),
      ),
    );
  }

  if (expanded && entry.compaction && entry.compaction.status !== "running") {
    const trigger = entry.compaction.trigger ?? entry.compaction.reason ?? (entry.compaction.auto ? "auto" : "manual");
    const requestDetail =
      entry.compaction.requestBytes !== undefined
        ? ` · request ${formatBytes(entry.compaction.requestBytes)}${
            entry.compaction.maxRequestBytes
              ? `/${formatBytes(entry.compaction.maxRequestBytes)}`
              : ""
          }`
        : "";
    const budgetDetail =
      entry.compaction.inputBudget !== undefined
        ? ` · budget ${formatTokenCount(entry.compaction.inputBudget)}`
        : "";
    rows.push(...wrapText(`trigger ${trigger}${requestDetail}${budgetDetail}`, Math.max(1, width)).map((line, index) => ({
      key: `${entry.id}-footer-${index}`,
      node: <Text color={theme.muted} wrap="truncate">{line}</Text>,
    })));
  }

  return rows;
}

function userRows(entry: ChatEntryView, width: number, theme: Theme): TranscriptRow[] {
  return wrapText(entry.text, Math.max(1, width - 2)).map((line, index) => ({
    key: `${entry.id}-line-${index}`,
    node: (
      <Text wrap="truncate">
        <Text color={theme.accent} bold>
          ▌{" "}
        </Text>
        <Text color={theme.text} bold>
          {line || " "}
        </Text>
      </Text>
    ),
  }));
}

function systemRows(entry: ChatEntryView, width: number, theme: Theme): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  entry.text.split("\n").forEach((line, lineIndex) => {
    wrapText(line, Math.max(1, width - 3)).forEach((chunk, chunkIndex) => {
      rows.push({
        key: `${entry.id}-line-${lineIndex}-${chunkIndex}`,
        node: (
          <Text wrap="truncate">
            <Text color={entry.kind === "recap" ? theme.muted : theme.status.info}>
              {lineIndex === 0 && chunkIndex === 0 ? "ℹ " : "  "}
            </Text>
            <Text color={entry.kind === "recap" ? theme.muted : theme.text}>{chunk}</Text>
          </Text>
        ),
      });
    });
  });
  return rows;
}

function assistantRows(
  entry: ChatEntryView,
  options: BuildTranscriptOptions,
  now: number,
): TranscriptRow[] {
  const width = options.width;
  const theme = options.theme;
  const rows: TranscriptRow[] = [];
  const liveView = entry.live && !entry.frozenLive;
  const allCalls = entry.toolCalls ?? [];
  const liveCalls = liveView ? allCalls.slice(-LIVE_TOOL_LIMIT) : allCalls;
  const hiddenLiveCalls = allCalls.length - liveCalls.length;
  const addGap = (key: string): void => {
    if (rows.length === 0) return;
    const last = rows[rows.length - 1];
    if (last.key.includes("-gap") || last.key.includes("-spacer")) return;
    rows.push(blankRow(key));
  };

  const segmented = Boolean(entry.thinkingSegments && entry.thinkingSegments.length > 0);
  // A model that answers inside its reasoning stream would otherwise show the
  // same text twice: once as thinking and once as the answer.
  const flatAnswer = (entry.text ?? "").replace(/\s+/g, " ").trim();
  const flatThinking = (entry.thinkingSegments ?? [])
    .filter((segment) => segment.kind !== "text")
    .map((segment) => segment.text.replace(/\s+/g, " "))
    .join(" ");
  const answerCameFromThinking =
    !entry.live && flatAnswer.length >= 24 && flatThinking.includes(flatAnswer.slice(0, 200));
  if (segmented) {
    const segments = entry.thinkingSegments ?? [];
    segments.forEach((segment, index) => {
      const next = segments[index + 1];
      const visibleSegment = !liveView || segment.completedAt !== undefined;
      if (segment.kind === "text") {
        addGap(`${entry.id}-narration-gap-${index}`);
        rows.push(...markdownRows(segment.text, width, theme).map((row) => ({
          ...row, key: `${entry.id}-narration-${index}-${row.key}`,
        })));
      } else if (visibleSegment && !answerCameFromThinking) {
        addGap(`${entry.id}-thought-gap-${index}`);
        const duration = Math.max(
          0,
          (segment.completedAt ?? now) - segment.startedAt,
        );
        rows.push(
          thinkingHeaderRow(duration, 1, theme, `${entry.id}-thought-${index}`),
        );
        if (options.thinkingExpanded) {
          rows.push(
            ...thinkingTextRows(
              segment.text,
              width,
              theme,
              `${entry.id}-thought-text-${index}`,
            ),
          );
        }
      } else if (liveView) {
        if (options.thinkingExpanded) {
          // The live status line owns the indicator. Expanding the block shows
          // the reasoning as it streams, without a second "Thinking" label.
          addGap(`${entry.id}-thought-gap-${index}`);
          rows.push(
            ...thinkingTextRows(
              segment.text,
              width,
              theme,
              `${entry.id}-thought-text-${index}`,
            ),
          );
        }
      }

      const start = Math.max(0, segment.toolIndex - hiddenLiveCalls);
      const end = Math.min(
        liveCalls.length,
        (next ? next.toolIndex : allCalls.length) - hiddenLiveCalls,
      );
      liveCalls.slice(start, Math.max(start, end)).forEach((call, callIndex) => {
        addGap(`${entry.id}-tool-gap-${index}-${callIndex}`);
        rows.push(
          ...toolCallRows(
            call,
            width,
            options.collapsed,
            theme,
            `${entry.id}-tool-${index}-${callIndex}`,
            options.diffExpanded ?? false,
          ),
        );
      });
    });
  } else if (entry.thinking) {
    if (liveView) {
      if (entry.thinkingCompletedAt !== undefined) {
        const duration =
          entry.thinkingStartedAt !== undefined
            ? Math.max(0, entry.thinkingCompletedAt - entry.thinkingStartedAt)
            : undefined;
        rows.push(thinkingHeaderRow(duration, 1, theme, `${entry.id}-thought`));
        if (options.thinkingExpanded) {
          rows.push(...thinkingTextRows(entry.thinking, width, theme, `${entry.id}-thought-text`));
        }
      } else if (options.thinkingExpanded) {
        rows.push(...thinkingTextRows(entry.thinking, width, theme, `${entry.id}-thought-text`));
      }
    } else if (options.thinkingExpanded) {
      const duration =
        entry.thinkingStartedAt !== undefined && entry.thinkingCompletedAt !== undefined
          ? entry.thinkingCompletedAt - entry.thinkingStartedAt
          : undefined;
      rows.push(thinkingHeaderRow(duration, 1, theme, `${entry.id}-thought`));
      rows.push(...thinkingTextRows(entry.thinking, width, theme, `${entry.id}-thought`));
    } else {
      const duration =
        entry.thinkingStartedAt !== undefined && entry.thinkingCompletedAt !== undefined
          ? entry.thinkingCompletedAt - entry.thinkingStartedAt
          : undefined;
      rows.push(thinkingHeaderRow(duration, 1, theme, `${entry.id}-thought`));
    }
  }

  if (!segmented) {
    liveCalls.forEach((call, index) => {
      addGap(`${entry.id}-tool-gap-${index}`);
      rows.push(
        ...toolCallRows(
          call,
          width,
          options.collapsed,
          theme,
          `${entry.id}-tool-${index}`,
          options.diffExpanded ?? false,
        ),
      );
    });
  }

  if (hiddenLiveCalls > 0) {
    rows.push({
      key: `${entry.id}-live-tools-hidden`,
      node: (
        <Text wrap="truncate" color={theme.muted}>
          … {hiddenLiveCalls} earlier tool call{hiddenLiveCalls === 1 ? "" : "s"} hidden while live
        </Text>
      ),
    });
  }

  const linkedPaths = new Set<string>();
  for (const call of allCalls) {
    if (call.filePath) linkedPaths.add(call.filePath);
    if (call.diff?.oldLabel) linkedPaths.add(call.diff.oldLabel.replace(/^[ab]\//, ""));
    if (call.diff?.newLabel) linkedPaths.add(call.diff.newLabel.replace(/^[ab]\//, ""));
  }
  const files = (liveView ? (entry.files ?? []).slice(-2) : (entry.files ?? [])).filter(
    (file) => !linkedPaths.has(file.path),
  );
  files.forEach((file, fileIndex) => {
    rows.push({
      key: `${entry.id}-file-${fileIndex}`,
      node: (
        <Text color={theme.muted} wrap="truncate">
          {file.path}
          {file.additions !== undefined || file.deletions !== undefined
            ? ` (+${file.additions ?? 0} -${file.deletions ?? 0})`
            : ""}
        </Text>
      ),
    });
    if (options.collapsed) {
      rows.push({
        key: `${entry.id}-file-${fileIndex}-hidden`,
        node: (
          <Text wrap="truncate" color={theme.muted}>
            diff hidden (Ctrl+O to expand)
          </Text>
        ),
      });
    } else {
      const diff = options.diffExpanded
        ? diffRows(
            file.oldText,
            file.newText,
            `a/${file.path}`,
            `b/${file.path}`,
            width,
            theme,
            true,
            undefined,
            { showFileHeader: false },
          )
        : diffPreviewRows(file.oldText, file.newText, width, theme);
      rows.push(
        ...diff.map((row, index) => ({
          ...row,
          key: `${entry.id}-file-${fileIndex}-diff-${index}`,
        })),
      );
    }
  });

  if (entry.diff) {
    if (options.collapsed) {
      rows.push({
        key: `${entry.id}-diff-hidden`,
        node: (
          <Text color={theme.muted} wrap="truncate">
            diff hidden: {entry.diff.oldLabel ?? "old"} → {entry.diff.newLabel ?? "new"} (Ctrl+O to expand)
          </Text>
        ),
      });
    } else {
      const diff = options.diffExpanded
        ? diffRows(
            entry.diff.oldText,
            entry.diff.newText,
            entry.diff.oldLabel ?? "old",
            entry.diff.newLabel ?? "new",
            width,
            theme,
            entry.diff.unified ?? false,
          )
        : diffPreviewRows(entry.diff.oldText, entry.diff.newText, width, theme);
      rows.push(
        ...diff.map((row, index) => ({ ...row, key: `${entry.id}-diff-${index}` })),
      );
    }
  }

  if (entry.text) {
    addGap(`${entry.id}-answer-gap`);
    const live = liveView ? liveDisplayText(entry.text) : undefined;
    if (live?.truncated) {
      rows.push({
        key: `${entry.id}-live-tail`,
        node: (
          <Text wrap="truncate" color={theme.muted}>
            … showing latest output (full answer after the turn)
          </Text>
        ),
      });
      rows.push(...plainTextRows(live.text, width, theme, `${entry.id}-text`));
    } else {
      rows.push(
        ...markdownRows(entry.text, width, theme).map((row, index) => ({
          ...row,
          key: `${entry.id}-text-${index}`,
        })),
      );
    }
    if (
      !entry.live &&
      (entry.mode || entry.model || entry.completedAt !== undefined || entry.responseDurationMs !== undefined || entry.tokensPerSecond !== undefined || entry.turnTokens !== undefined || entry.filesChanged !== undefined)
    ) {
      addGap(`${entry.id}-metadata-gap`);
      const metadata = [
        entry.completedAt !== undefined ? formatReplyDate(entry.completedAt) : undefined,
        entry.responseDurationMs !== undefined ? `took ${formatThinkingDuration(entry.responseDurationMs)}` : undefined,
        entry.mode?.toUpperCase(),
        entry.model,
        entry.tokensPerSecond !== undefined && Number.isFinite(entry.tokensPerSecond)
          ? `${entry.tokensPerSecond.toFixed(1)} tok/s`
          : undefined,
        entry.filesChanged !== undefined
          ? `${entry.filesChanged} file${entry.filesChanged === 1 ? "" : "s"} changed`
          : undefined,
        entry.turnTokens !== undefined ? `turn total ${formatTokenCount(entry.turnTokens)} tokens` : undefined,
        entry.turnPromptTokens !== undefined ? `${formatTokenCount(entry.turnPromptTokens)} input` : undefined,
        entry.turnCompletionTokens !== undefined ? `${formatTokenCount(entry.turnCompletionTokens)} output` : undefined,
        entry.turnRequests !== undefined ? `${entry.turnRequests} reported requests` : undefined,
      ].filter(Boolean).join(" · ");
      wrapText(metadata, Math.max(1, width)).forEach((line, index) => rows.push({
        key: `${entry.id}-meta-${index}`, node: <Text color={theme.muted} wrap="truncate">{line}</Text>,
      }));
    }
  }

  return rows;
}

function buildEntryRows(
  entry: ChatEntryView,
  options: BuildTranscriptOptions,
  now: number,
): TranscriptRow[] {
  const theme = options.theme;
  if (entry.role === "compaction") {
    return compactionRows(entry, options.width, options.diffExpanded ?? false, theme);
  }
  if (entry.role === "user") return userRows(entry, options.width, theme);
  if (entry.role === "system") return systemRows(entry, options.width, theme);
  return assistantRows(entry, options, now);
}

const entryRowCache = new WeakMap<ChatEntryView, Map<string, TranscriptRow[]>>();

function cacheKey(entry: ChatEntryView, options: BuildTranscriptOptions): string {
  return [
    options.width,
    options.collapsed ? 1 : 0,
    options.diffExpanded ? 1 : 0,
    options.thinkingExpanded ? 1 : 0,
    options.expandedGroups.has(entry.id) ? 1 : 0,
    options.theme.name,
    entry.frozenLive ? 1 : 0,
    entry.text.length,
  ].join(":");
}

export function buildTranscriptRows(
  entries: ChatEntryView[],
  options: BuildTranscriptOptions,
): TranscriptRow[] {
  const index = new TranscriptRowIndex(entries, options);
  return index.slice(0, index.length);
}

export class TranscriptRowIndex {
  readonly length: number;
  private readonly sections: Array<{ start: number; rows: TranscriptRow[] }> = [];

  constructor(entries: ChatEntryView[], options: BuildTranscriptOptions) {
    const now = options.now ?? Date.now();
    let length = 0;
    const buildRows = (entry: ChatEntryView): TranscriptRow[] =>
      buildEntryRows(entry, options, now).map((row) =>
        row.entryId === undefined ? { ...row, entryId: entry.id } : row,
      );

    for (const entry of entries) {
      let entryRows: TranscriptRow[];
      if (entry.live && !entry.frozenLive) {
        entryRows = buildRows(entry);
      } else {
        let cache = entryRowCache.get(entry);
        if (!cache) {
          cache = new Map();
          entryRowCache.set(entry, cache);
        }
        const key = cacheKey(entry, options);
        const cached = cache.get(key);
        if (cached) {
          entryRows = cached;
        } else {
          entryRows = buildRows(entry);
          if (cache.size > 8) cache.clear();
          cache.set(key, entryRows);
        }
      }

      if (entryRows.length === 0) continue;
      if (length > 0) {
        this.sections.push({
          start: length++,
          rows: [{ ...blankRow(`${entry.id}-spacer`), entryId: entry.id }],
        });
      }
      this.sections.push({ start: length, rows: entryRows });
      length += entryRows.length;
    }
    this.length = length;
  }

  slice(start: number, end: number): TranscriptRow[] {
    const rows: TranscriptRow[] = [];
    const from = Math.max(0, start);
    const to = Math.min(this.length, end);
    let low = 0;
    let high = this.sections.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const section = this.sections[middle];
      if (section.start + section.rows.length <= from) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < this.sections.length; index += 1) {
      const section = this.sections[index];
      if (section.start >= to) break;
      const first = Math.max(0, from - section.start);
      const last = Math.min(section.rows.length, to - section.start);
      for (let row = first; row < last; row += 1) {
        rows.push(section.rows[row]);
      }
    }
    return rows;
  }
}
