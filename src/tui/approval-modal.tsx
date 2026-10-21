import React from "react";
import { Box, Text, useInput } from "ink";

import type { ApprovalDecision, ApprovalRequest } from "../agent/permissions";
import { collectDiffHunks, diffRows } from "./diff-view";
import { isMouseSequence } from "./mouse";
import type { RenderRow } from "./rows";
import { getTheme, type Theme } from "./theme";
import { displayWidth, fitDisplayText, wrapPreservingWhitespace } from "./text-wrap";

export interface ToolApprovalModalProps {
  request: ApprovalRequest;
  onDecision: (decision: ApprovalDecision) => void;
  width?: number;
  height?: number;
  theme?: Theme;
}

const ACTIONS = [
  { id: "approve_once", label: "Approve once", short: "Approve" },
  { id: "always_allow", label: "Always allow", short: "Always" },
  { id: "deny", label: "Deny", short: "Deny" },
  { id: "deny_with_feedback", label: "Deny with feedback", short: "Feedback" },
] as const;

function actionForTool(toolName: string): string {
  if (toolName === "create_file") return "Create";
  if (toolName === "delete_file") return "Delete";
  if (toolName === "move_file") return "Move";
  return "Edit";
}

function previewTextRows(
  text: string,
  width: number,
  theme: Theme,
  prefix = "  ",
): RenderRow[] {
  return text.split("\n").flatMap((line, lineIndex) =>
    wrapPreservingWhitespace(line, Math.max(8, width - prefix.length)).map((chunk, chunkIndex) => ({
      key: `preview-${lineIndex}-${chunkIndex}`,
      node: (
        <Text color={theme.text} wrap="truncate">
          {prefix}
          {chunk || " "}
        </Text>
      ),
    })),
  );
}

function alwaysAllowScope(request: ApprovalRequest): string {
  if (request.alwaysAllowLabel) return request.alwaysAllowLabel;
  if (request.shellDetails) return "this command family in this workspace";
  if (request.diffPreview) return "edits in this workspace";
  return "this tool";
}

export function ToolApprovalModal(props: ToolApprovalModalProps) {
  const {
    request,
    onDecision,
    width = 80,
    height = 24,
    theme = getTheme("tokyonight"),
  } = props;

  const [feedbackMode, setFeedbackMode] = React.useState(false);
  const [feedbackText, setFeedbackText] = React.useState("");
  const [selected, setSelected] = React.useState(0);
  const [previewOffset, setPreviewOffset] = React.useState(0);

  const safeWidth = Math.max(20, width);
  const safeHeight = Math.max(1, height);
  const contentWidth = Math.max(12, safeWidth - 4);
  const innerHeight = Math.max(1, safeHeight - 2);
  const compact = safeWidth < 64 || innerHeight < 16;
  const veryCompact = innerHeight < 9;
  const minimal = innerHeight < 4;

  const clamped = Math.max(0, Math.min(ACTIONS.length - 1, selected));
  const target = request.diffPreview
    ? request.diffPreview.filePath
    : request.shellDetails
      ? request.shellDetails.command
      : request.toolName;
  const actionLabel = request.diffPreview
    ? actionForTool(request.toolName)
    : request.shellDetails
      ? "Run"
      : "Use";

  const stats = React.useMemo(() => {
    if (!request.diffPreview) return undefined;
    const hunks = collectDiffHunks(
      request.diffPreview.oldText,
      request.diffPreview.newText,
      3,
    );
    let additions = 0;
    let deletions = 0;
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add") additions += 1;
        else if (line.kind === "remove") deletions += 1;
      }
    }
    return { additions, deletions };
  }, [request.diffPreview]);

  const previewTheme = React.useMemo(
    (): Theme => ({
      ...theme,
      diff: {
        added: theme.text,
        removed: theme.muted,
        hunkHeader: theme.muted,
      },
    }),
    [theme],
  );

  const previewRows = React.useMemo((): RenderRow[] => {
    if (request.diffPreview) {
      const filePath = request.diffPreview.filePath;
      return diffRows(
        request.diffPreview.oldText,
        request.diffPreview.newText,
        `a/${filePath}`,
        `b/${filePath}`,
        contentWidth,
        previewTheme,
        true,
      );
    }
    if (request.shellDetails) {
      const rows: RenderRow[] = [];
      wrapPreservingWhitespace(
        request.shellDetails.command,
        Math.max(8, contentWidth - 2),
      ).forEach((line, index) => {
        rows.push({
          key: `shell-${index}`,
          node: (
            <Text color={theme.text} wrap="truncate">
              <Text bold>{index === 0 ? "$ " : "  "}</Text>
              {line}
            </Text>
          ),
        });
      });
      if (request.shellDetails.warning) {
        rows.push({
          key: "shell-warning",
          node: (
            <Text color={theme.text} wrap="truncate">
              {fitDisplayText(request.shellDetails.warning, contentWidth)}
            </Text>
          ),
        });
      }
      return rows;
    }
    return previewTextRows(
      JSON.stringify(request.args, null, 2),
      contentWidth,
      theme,
    );
  }, [request, contentWidth, previewTheme, theme]);

  const actionRows = feedbackMode
    ? Math.min(3, innerHeight)
    : minimal
      ? Math.min(2, innerHeight)
      : veryCompact
        ? innerHeight >= 4
          ? 3
          : 2
        : compact
          ? 3
          : 5;
  const headerRows = minimal ? 0 : compact ? 1 : 2;
  const separatorRows = innerHeight - headerRows - actionRows >= 1 ? 1 : 0;
  const previewHeight = Math.max(
    0,
    innerHeight - headerRows - actionRows - separatorRows,
  );
  const maxOffset =
    previewHeight > 0 ? Math.max(0, previewRows.length - previewHeight) : 0;
  const offset = Math.min(previewOffset, maxOffset);
  const visiblePreview = previewRows.slice(offset, offset + previewHeight);

  React.useEffect(() => {
    setSelected(0);
    setFeedbackMode(false);
    setFeedbackText("");
    setPreviewOffset(0);
  }, [request.id]);

  useInput((input, key) => {
    if (isMouseSequence(input)) return;
    if (feedbackMode) {
      if (key.return) {
        const trimmed = feedbackText.trim();
        onDecision({
          approved: false,
          choice: "deny_with_feedback",
          feedback:
            trimmed.length > 0
              ? trimmed
              : "Denied by user without additional feedback.",
        });
        return;
      }
      if (key.escape) {
        setFeedbackMode(false);
        setFeedbackText("");
        return;
      }
      if (key.backspace || key.delete || input === "\x7f" || input === "\b") {
        setFeedbackText((prev) => prev.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input.length > 0 && input >= " " && input !== "\x7f") {
        setFeedbackText((prev) => prev + input);
      }
      return;
    }

    if (key.escape) {
      onDecision({
        approved: false,
        choice: "deny",
        reason: "Tool execution cancelled by user.",
      });
      return;
    }

    if (/^[1-4]$/.test(input)) {
      setSelected(Number(input) - 1);
      return;
    }

    if (key.pageUp) {
      setPreviewOffset((value) =>
        Math.max(0, value - Math.max(1, previewHeight - 1)),
      );
      return;
    }
    if (key.pageDown) {
      setPreviewOffset((value) =>
        Math.min(maxOffset, value + Math.max(1, previewHeight - 1)),
      );
      return;
    }

    if (key.upArrow) {
      setSelected((value) => (value > 0 ? value - 1 : ACTIONS.length - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((value) => (value < ACTIONS.length - 1 ? value + 1 : 0));
      return;
    }
    if (!key.return) return;

    const action = ACTIONS[clamped];
    if (action.id === "approve_once") {
      onDecision({ approved: true, choice: "approve_once" });
    } else if (action.id === "always_allow") {
      onDecision({ approved: true, choice: "always_allow" });
    } else if (action.id === "deny") {
      onDecision({
        approved: false,
        choice: "deny",
        reason: "Tool execution cancelled by user.",
      });
    } else {
      setFeedbackMode(true);
      setFeedbackText("");
    }
  });

  const rightHeader = fitDisplayText(
    `${actionLabel} · ${request.mode.toUpperCase()}`,
    Math.max(8, Math.floor(contentWidth * 0.45)),
  );
  const leftHeader = fitDisplayText(
    "Permission required",
    Math.max(8, contentWidth - displayWidth(rightHeader) - 2),
  );
  const targetLine = fitDisplayText(
    `${target}${stats ? ` +${stats.additions} -${stats.deletions}` : ""}${
      request.shellDetails ? ` · ${request.shellDetails.riskLevel.toUpperCase()}` : ""
    }`,
    contentWidth,
  );

  const renderAction = (
    index: number,
    label: string,
    maxWidth: number,
  ): React.ReactElement => {
    const active = index === clamped;
    return (
      <Text key={ACTIONS[index].id}>
        <Text color={active ? theme.text : theme.muted}>{active ? "❯ " : "  "}</Text>
        <Text color={theme.muted}>{`${index + 1}. `}</Text>
        <Text bold={active} color={active ? theme.text : theme.muted}>
          {fitDisplayText(label, maxWidth)}
        </Text>
      </Text>
    );
  };

  const actionHalfWidth = Math.max(6, Math.floor((contentWidth - 3) / 2));
  const helpBase =
    contentWidth >= 50
      ? "↑↓ choose · Enter select · Esc deny"
      : "↑↓ move · Enter select · Esc deny";
  const helpText = fitDisplayText(
    `${helpBase}${maxOffset > 0 ? " · PgUp/PgDn preview" : ""}`,
    contentWidth,
  );
  const alwaysLabel =
    request.shellDetails || request.diffPreview
      ? `Always allow ${alwaysAllowScope(request)}`
      : ACTIONS[1].label;

  const footer = feedbackMode ? (
    <Box flexDirection="column" height={actionRows} overflow="hidden">
      {actionRows >= 2 ? (
        <Text bold color={theme.text}>
          Rejection feedback
        </Text>
      ) : null}
      <Text wrap="truncate">
        <Text color={theme.muted}>❯ </Text>
        <Text color={theme.text}>{feedbackText}</Text>
        <Text inverse color={theme.text}> </Text>
      </Text>
      {actionRows >= 3 ? (
        <Text color={theme.muted} wrap="truncate">
          Enter send · Esc back
        </Text>
      ) : null}
    </Box>
  ) : actionRows <= 1 ? (
    <Text color={theme.muted} wrap="truncate">
      {fitDisplayText(
        `1 ${ACTIONS[0].short}  2 ${ACTIONS[1].short}  3 ${ACTIONS[2].short}  4 ${ACTIONS[3].short}`,
        contentWidth,
      )}
    </Text>
  ) : actionRows === 2 ? (
    <Box flexDirection="column" height={2} overflow="hidden">
      <Box justifyContent="space-between">
        {renderAction(0, ACTIONS[0].short, actionHalfWidth)}
        {renderAction(1, ACTIONS[1].short, actionHalfWidth)}
      </Box>
      <Box justifyContent="space-between">
        {renderAction(2, ACTIONS[2].short, actionHalfWidth)}
        {renderAction(3, ACTIONS[3].short, actionHalfWidth)}
      </Box>
    </Box>
  ) : actionRows === 3 ? (
    <Box flexDirection="column" height={3} overflow="hidden">
      <Box justifyContent="space-between">
        {renderAction(0, ACTIONS[0].short, actionHalfWidth)}
        {renderAction(1, ACTIONS[1].short, actionHalfWidth)}
      </Box>
      <Box justifyContent="space-between">
        {renderAction(2, ACTIONS[2].short, actionHalfWidth)}
        {renderAction(3, ACTIONS[3].short, actionHalfWidth)}
      </Box>
      <Text color={theme.muted} wrap="truncate">
        {helpText}
      </Text>
    </Box>
  ) : (
    <Box flexDirection="column" height={5} overflow="hidden">
      {renderAction(0, ACTIONS[0].label, contentWidth - 6)}
      {renderAction(1, alwaysLabel, contentWidth - 6)}
      {renderAction(2, ACTIONS[2].label, contentWidth - 6)}
      {renderAction(3, ACTIONS[3].label, contentWidth - 6)}
      <Text color={theme.muted} wrap="truncate">
        {helpText}
      </Text>
    </Box>
  );

  return (
    <Box
      flexDirection="column"
      height={safeHeight}
      borderStyle="round"
      borderColor={theme.border.active}
      paddingX={1}
      overflow="hidden"
    >
      {headerRows > 0 ? (
        <Box flexDirection="column" height={headerRows} flexShrink={0} overflow="hidden">
          <Box height={1} justifyContent="space-between">
            <Text bold color={theme.text}>
              {leftHeader}
            </Text>
            <Text color={theme.muted}>{rightHeader}</Text>
          </Box>
          {headerRows > 1 ? (
            <Text color={theme.text} wrap="truncate">
              {targetLine}
            </Text>
          ) : null}
        </Box>
      ) : null}

      {previewHeight > 0 ? (
        <Box flexDirection="column" height={previewHeight} flexShrink={0} overflow="hidden">
          {visiblePreview.map((row) => (
            <React.Fragment key={row.key}>{row.node}</React.Fragment>
          ))}
        </Box>
      ) : null}

      {separatorRows > 0 ? (
        <Text color={theme.border.passive} wrap="truncate">
          {"─".repeat(contentWidth)}
        </Text>
      ) : null}

      <Box flexShrink={0}>{footer}</Box>
    </Box>
  );
}
