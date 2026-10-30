import React from "react";
import { Text } from "ink";

import { toolDisplay } from "../agent/tool-display";
import type { ChatEntryView, ChatToolCallView } from "./app";
import { diffRows, formatThinkingDuration } from "./diff-view";
import { formatTokenCount } from "./format";
import { hashlinePanelParts, parseHashlineOutput } from "./hashline-format";
import { markdownRows } from "./markdown";
import {
  panelPaddingRowNode,
  panelRowNode,
  type PanelPart,
} from "./panel";
import type { RenderRow } from "./rows";
import { getTheme, type Theme } from "./theme";
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
  theme?: Theme;
  collapsed: boolean;
  expandedGroups: ReadonlySet<string>;
  thinkingExpanded: boolean;
  spinner?: string;
  now?: number;
}

function blankRow(key: string): TranscriptRow {
  return { key, node: <Text> </Text> };
}

function dividerLine(label: string, width: number): string {
  const head = `── ${label} `;
  const safeWidth = Math.max(20, width);
  return `${head}${"─".repeat(Math.max(0, safeWidth - head.length))}`;
}

function statusIcon(status: ChatToolCallView["status"]): string {
  if (status === "running") return "●";
  if (status === "error") return "✖";
  return "✔";
}

function statusColor(status: ChatToolCallView["status"], theme: Theme): string {
  if (status === "running") return theme.badge.running;
  if (status === "error") return theme.badge.error;
  return theme.badge.ok;
}

const TOOL_MARGIN = 2;
const COMMAND_TOOL_NAMES = new Set(["bash", "run_sandbox_script", "bg_start", "bg_logs"]);
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
  indent = 0,
  spinner?: string,
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
  // A command can contain newlines; the header must stay one terminal row.
  const target = singleLine(call.filePath ?? call.detail ?? "");
  const additions = call.diff?.additions;
  const deletions = call.diff?.deletions;
  const safeWidth = Math.max(16, width);
  const panelWidth = Math.max(16, safeWidth - TOOL_MARGIN * 2 - 1);
  const panelOptions = {
    width: panelWidth,
    background: theme.tool.background,
    margin: TOOL_MARGIN,
  };
  const innerPad = Math.max(2, indent + 2);
  const statusTint = statusColor(call.status, theme);

  const paddingRow = (key: string): TranscriptRow => ({
    key,
    node: panelPaddingRowNode(panelOptions),
  });
  const panelRow = (key: string, parts: PanelPart[]): TranscriptRow => ({
    key,
    node: panelRowNode(parts, panelOptions),
  });

  const icon = call.status === "running" ? spinner ?? "●" : statusIcon(call.status);
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
      text: ` ${call.durationMs}ms`,
      node: <Text color={theme.muted}> {call.durationMs}ms</Text>,
      color: theme.muted,
    });
  }
  if (call.lspStatus) {
    suffixParts.push({
      text: ` lsp:${call.lspStatus}`,
      node: <Text color={theme.badge.running}> lsp:{call.lspStatus}</Text>,
      color: theme.badge.running,
    });
  }

  const headerPrefix = `${" ".repeat(innerPad)}${icon} ${label}`;
  const suffixWidth = suffixParts.reduce((sum, part) => sum + displayWidth(part.text), 0);
  const targetWidth = Math.max(0, panelWidth - displayWidth(headerPrefix) - suffixWidth - 1);
  const fittedTarget = target && targetWidth > 3 ? ` ${fitDisplayText(target, targetWidth)}` : "";

  rows.push(paddingRow(`${keyPrefix}-panel-top`));
  rows.push(
    panelRow(keyPrefix, [
      { text: " ".repeat(innerPad) },
      { text: `${icon} `, node: <Text color={statusTint} bold>{icon} </Text>, color: statusTint },
      { text: label, node: <Text bold>{label}</Text> },
      ...(fittedTarget
        ? [
            {
              text: fittedTarget,
              node: <Text color={theme.text}>{fittedTarget}</Text>,
              color: theme.text,
            },
          ]
        : []),
      ...suffixParts,
    ]),
  );

  if (isCommand) {
    const command = call.command ?? call.detail ?? "";
    if (command.length > 0) {
      wrapPreservingWhitespace(command, Math.max(8, panelWidth - innerPad - 4)).forEach(
        (line, index) => {
          const prompt = index === 0 ? "$ " : "  ";
          rows.push(
            panelRow(`${keyPrefix}-command-${index}`, [
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
  }

  if (call.output) {
    const outputTint = call.status === "error" ? theme.diff.removed : theme.muted;
    if (collapsed) {
      const plain = `${" ".repeat(innerPad)}output hidden (Ctrl+O to expand)`;
      rows.push(
        panelRow(`${keyPrefix}-output-hidden`, [
          { text: plain, node: <Text color={theme.muted}>{plain}</Text>, color: theme.muted },
        ]),
      );
    } else {
      const lines = call.output.split("\n");
      const visible = lines.slice(0, isCommand ? 24 : 14);
      const anchored = HASHLINE_TOOL_NAMES.has(call.name)
        ? parseHashlineOutput(visible.join("\n"))
        : undefined;
      if (anchored) {
        hashlinePanelParts(anchored.lines, { panelWidth, innerPad, theme }).forEach(
          (parts, index) => {
            rows.push(panelRow(`${keyPrefix}-output-anchored-${index}`, parts));
          },
        );
        if (anchored.notice) {
          const plain = `${" ".repeat(innerPad)}${anchored.notice}`;
          rows.push(
            panelRow(`${keyPrefix}-output-notice`, [
              { text: plain, node: <Text color={theme.muted}>{plain}</Text>, color: theme.muted },
            ]),
          );
        }
      } else {
        visible.forEach((line, lineIndex) => {
          wrapPreservingWhitespace(line, Math.max(8, panelWidth - innerPad - 2)).forEach(
            (chunk, chunkIndex) => {
              const body = chunk || " ";
              rows.push(
                panelRow(`${keyPrefix}-output-${lineIndex}-${chunkIndex}`, [
                  { text: " ".repeat(innerPad) },
                  { text: body, node: <Text color={outputTint}>{body}</Text>, color: outputTint },
                ]),
              );
            },
          );
        });
      }
      if (lines.length > visible.length) {
        const plain = `${" ".repeat(innerPad)}… ${lines.length - visible.length} more lines`;
        rows.push(
          panelRow(`${keyPrefix}-output-more`, [
            { text: plain, node: <Text color={theme.muted}>{plain}</Text>, color: theme.muted },
          ]),
        );
      }
    }
  }

  if (call.diff) {
    if (collapsed) {
      const plain = `${" ".repeat(innerPad)}diff hidden (Ctrl+O to expand)`;
      rows.push(
        panelRow(`${keyPrefix}-diff-hidden`, [
          { text: plain, node: <Text color={theme.muted}>{plain}</Text>, color: theme.muted },
        ]),
      );
    } else {
      rows.push(
        ...diffRows(
          call.diff.oldText,
          call.diff.newText,
          call.diff.oldLabel ?? `a/${target ?? "file"}`,
          call.diff.newLabel ?? `b/${target ?? "file"}`,
          panelWidth,
          theme,
          true,
          theme.tool.background,
        ).map((row, index) => ({
          ...row,
          key: `${keyPrefix}-diff-${index}`,
          node: (
            <Text wrap="truncate">
              {" ".repeat(TOOL_MARGIN)}
              {row.node}
            </Text>
          ),
        })),
      );
    }
  }

  rows.push(paddingRow(`${keyPrefix}-panel-bottom`));
  return rows;
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
          <Text color={theme.border.passive}>▎ </Text>
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
        <Text color={theme.border.passive}>▎ </Text>
        <Text color={theme.badge.running} bold>
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
  collapsed: boolean,
  theme: Theme,
): TranscriptRow[] {
  const label =
    entry.compaction?.status === "running"
      ? "compacting"
      : entry.compaction?.reason === "output_limit"
        ? "output limit compacted"
        : entry.compaction?.auto
          ? "auto compacted"
          : "compacted";
  const rows: TranscriptRow[] = [
    {
      key: `${entry.id}-divider`,
      node: (
        <Text color={theme.border.passive} wrap="truncate">
          {dividerLine(label, width)}
        </Text>
      ),
    },
  ];

  if (entry.compaction?.status === "running") {
    rows.push({
      key: `${entry.id}-running`,
      node: <Text color={theme.badge.running}>compacting...</Text>,
    });
  } else if (entry.text) {
    if (collapsed) {
      rows.push({
        key: `${entry.id}-hidden`,
        node: <Text color={theme.muted}>summary hidden (Ctrl+O to expand)</Text>,
      });
    } else {
      rows.push(
        ...markdownRows(entry.text, width, theme).map((row, index) => ({
          ...row,
          key: `${entry.id}-summary-${index}`,
        })),
      );
    }
  }

  if (entry.compaction?.error) {
    rows.push({
      key: `${entry.id}-error`,
      node: <Text color={theme.badge.error}>{entry.compaction.error}</Text>,
    });
  }

  if (entry.compaction && entry.compaction.status !== "running") {
    rows.push({
      key: `${entry.id}-footer`,
      node: (
        <Text color={theme.border.passive} wrap="truncate">
          {dividerLine(
            `${formatTokenCount(entry.compaction.beforeTokens)} -> ${formatTokenCount(
              entry.compaction.afterTokens,
            )} tokens · ${entry.compaction.removedMessages} messages removed`,
            width,
          )}
        </Text>
      ),
    });
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
            <Text color={theme.modes.plan.primary}>
              {lineIndex === 0 && chunkIndex === 0 ? "ℹ " : "  "}
            </Text>
            <Text color={theme.text}>{chunk}</Text>
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
  const theme = options.theme ?? getTheme("tokyonight");
  const rows: TranscriptRow[] = [];
  const allCalls = entry.toolCalls ?? [];
  const addGap = (key: string): void => {
    if (rows.length === 0) return;
    const last = rows[rows.length - 1];
    if (last.key.includes("-gap") || last.key.includes("-spacer")) return;
    rows.push(blankRow(key));
  };

  const beforeThinking = rows.length;
  const segmented = Boolean(entry.thinkingSegments && entry.thinkingSegments.length > 0);
  // A model that answers inside its reasoning stream would otherwise show the
  // same text twice: once as thinking and once as the answer.
  const flatAnswer = (entry.text ?? "").replace(/\s+/g, " ").trim();
  const flatThinking = (entry.thinkingSegments ?? [])
    .map((segment) => segment.text.replace(/\s+/g, " "))
    .join(" ");
  const answerCameFromThinking =
    !entry.live && flatAnswer.length >= 24 && flatThinking.includes(flatAnswer.slice(0, 200));
  if (segmented) {
    const segments = entry.thinkingSegments ?? [];
    segments.forEach((segment, index) => {
      const next = segments[index + 1];
      const visibleSegment = !entry.live || segment.completedAt !== undefined;
      if (visibleSegment && !answerCameFromThinking) {
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
      } else if (entry.live) {
        if (entry.text) {
          rows.push(
            thinkingHeaderRow(
              Math.max(0, now - segment.startedAt),
              1,
              theme,
              `${entry.id}-thought-${index}`,
            ),
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
        } else if (options.thinkingExpanded) {
          // The live status line owns the indicator. Expanding the block shows
          // the reasoning as it streams, without a second "Thinking" label.
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

      const start = segment.toolIndex;
      const end = next ? next.toolIndex : allCalls.length;
      allCalls.slice(start, end).forEach((call, callIndex) => {
        addGap(`${entry.id}-tool-gap-${index}-${callIndex}`);
        rows.push(
          ...toolCallRows(
            call,
            width,
            options.collapsed,
            theme,
            `${entry.id}-tool-${index}-${callIndex}`,
            2,
            options.spinner,
          ),
        );
      });

      if (visibleSegment && index < segments.length - 1) {
        rows.push(blankRow(`${entry.id}-thought-gap-${index}`));
      }
    });
  } else if (entry.thinking) {
    if (entry.live) {
      if (entry.text) {
        const duration =
          entry.thinkingStartedAt !== undefined
            ? Math.max(0, now - entry.thinkingStartedAt)
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

  if (rows.length > beforeThinking) {
    addGap(`${entry.id}-thought-gap`);
  }

  if (!segmented) {
    allCalls.forEach((call, index) => {
      addGap(`${entry.id}-tool-gap-${index}`);
      rows.push(
        ...toolCallRows(
          call,
          width,
          options.collapsed,
          theme,
          `${entry.id}-tool-${index}`,
          0,
          options.spinner,
        ),
      );
    });
  }

  const linkedPaths = new Set<string>();
  for (const call of allCalls) {
    if (call.filePath) linkedPaths.add(call.filePath);
    if (call.diff?.oldLabel) linkedPaths.add(call.diff.oldLabel.replace(/^[ab]\//, ""));
    if (call.diff?.newLabel) linkedPaths.add(call.diff.newLabel.replace(/^[ab]\//, ""));
  }
  const files = (entry.live ? (entry.files ?? []).slice(-2) : (entry.files ?? [])).filter(
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
        node: <Text color={theme.muted}>diff hidden (Ctrl+O to expand)</Text>,
      });
    } else {
      rows.push(
        ...diffRows(
          file.oldText,
          file.newText,
          `a/${file.path}`,
          `b/${file.path}`,
          width,
          theme,
          true,
        ).map((row, index) => ({ ...row, key: `${entry.id}-file-${fileIndex}-diff-${index}` })),
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
      rows.push(
        ...diffRows(
          entry.diff.oldText,
          entry.diff.newText,
          entry.diff.oldLabel ?? "old",
          entry.diff.newLabel ?? "new",
          width,
          theme,
          entry.diff.unified ?? false,
        ).map((row, index) => ({ ...row, key: `${entry.id}-diff-${index}` })),
      );
    }
  }

  if (entry.text) {
    if (!entry.live) addGap(`${entry.id}-answer-gap`);
    rows.push(
      ...markdownRows(entry.text, width, theme).map((row, index) => ({
        ...row,
        key: `${entry.id}-text-${index}`,
      })),
    );
    if (
      !entry.live &&
      (entry.mode || entry.model || entry.tokensPerSecond !== undefined || entry.turnTokens !== undefined || entry.filesChanged !== undefined)
    ) {
      rows.push({
        key: `${entry.id}-meta`,
        node: (
          <Text color={theme.muted} wrap="truncate">
            {[
              entry.mode?.toUpperCase(),
              entry.model,
              entry.tokensPerSecond !== undefined && Number.isFinite(entry.tokensPerSecond)
                ? `${entry.tokensPerSecond.toFixed(1)} tok/s`
                : undefined,
              entry.filesChanged !== undefined
                ? `${entry.filesChanged} file${entry.filesChanged === 1 ? "" : "s"} changed`
                : undefined,
              entry.turnTokens !== undefined
                ? `turn ${formatTokenCount(entry.turnTokens)} tokens`
                : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        ),
      });
    }
  }

  return rows;
}

function buildEntryRows(
  entry: ChatEntryView,
  options: BuildTranscriptOptions,
  now: number,
): TranscriptRow[] {
  const theme = options.theme ?? getTheme("tokyonight");
  if (entry.role === "compaction") {
    return compactionRows(entry, options.width, options.collapsed, theme);
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
    options.thinkingExpanded ? 1 : 0,
    options.expandedGroups.has(entry.id) ? 1 : 0,
    (options.theme ?? getTheme("tokyonight")).name,
  ].join(":");
}

export function buildTranscriptRows(
  entries: ChatEntryView[],
  options: BuildTranscriptOptions,
): TranscriptRow[] {
  const now = options.now ?? Date.now();
  const rows: TranscriptRow[] = [];

  for (const entry of entries) {
    let entryRows: TranscriptRow[];
    if (entry.live) {
      entryRows = buildEntryRows(entry, options, now);
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
        entryRows = buildEntryRows(entry, options, now);
        if (cache.size > 8) cache.clear();
        cache.set(key, entryRows);
      }
    }

    if (entryRows.length === 0) continue;
    if (rows.length > 0) rows.push({ ...blankRow(`${entry.id}-spacer`), entryId: entry.id });
    rows.push(
      ...entryRows.map((row) => (row.entryId === undefined ? { ...row, entryId: entry.id } : row)),
    );
  }

  return rows;
}
