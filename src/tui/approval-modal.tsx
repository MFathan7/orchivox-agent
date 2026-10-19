import React from "react";
import { Box, Text, useInput } from "ink";

import type { ApprovalDecision, ApprovalRequest } from "../agent/permissions";
import { DiffView } from "./diff-view";
import { isMouseSequence } from "./mouse";
import { getTheme, type Theme } from "./theme";

export interface ToolApprovalModalProps {
  request: ApprovalRequest;
  onDecision: (decision: ApprovalDecision) => void;
  theme?: Theme;
}

export function ToolApprovalModal(props: ToolApprovalModalProps) {
  const {
    request,
    onDecision,
    theme = getTheme("tokyonight"),
  } = props;

  const [feedbackMode, setFeedbackMode] = React.useState(false);
  const [feedbackText, setFeedbackText] = React.useState("");
  const [selected, setSelected] = React.useState(0);
  const actions = [
    { id: "approve_once", label: "Approve once", color: theme.modes.build.primary },
    { id: "always_allow", label: "Always allow", color: theme.modes.plan.primary },
    { id: "deny", label: "Deny", color: theme.diff.removed },
    { id: "deny_with_feedback", label: "Deny with feedback", color: theme.modes.ultrawork.primary },
  ] as const;
  const clamped = Math.max(0, Math.min(actions.length - 1, selected));

  const riskLevel = request.shellDetails?.riskLevel ?? "low";
  let borderColor = theme.border.active;
  if (riskLevel === "critical") {
    borderColor = theme.diff.removed;
  } else if (riskLevel === "high") {
    borderColor = theme.modes.ultrawork.secondary;
  } else if (riskLevel === "medium") {
    borderColor = theme.modes.ultrawork.primary;
  } else if (request.diffPreview) {
    borderColor = theme.modes.build.primary;
  }

  useInput((input, key) => {
    if (isMouseSequence(input)) return;
    if (feedbackMode) {
      if (key.return) {
        const trimmed = feedbackText.trim();
        onDecision({
          approved: false,
          choice: "deny_with_feedback",
          feedback: trimmed.length > 0 ? trimmed : "Denied by user without additional feedback.",
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

    if (key.upArrow) {
      setSelected((value) => (value > 0 ? value - 1 : actions.length - 1));
      return;
    }

    if (key.downArrow) {
      setSelected((value) => (value < actions.length - 1 ? value + 1 : 0));
      return;
    }

    if (!key.return) return;

    const action = actions[clamped];
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

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginY={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={borderColor}>
          TOOL APPROVAL REQUIRED
        </Text>
        <Text dimColor>
          Mode: {request.mode.toUpperCase()}  |  Tool: {request.toolName}
        </Text>
      </Box>

      {request.diffPreview ? (
        <Box flexDirection="column" marginY={1}>
          <Text bold color={theme.accent}>
            Diff Preview: {request.diffPreview.filePath}
          </Text>
          <DiffView
            oldText={request.diffPreview.oldText}
            newText={request.diffPreview.newText}
            oldLabel={request.diffPreview.oldLabel}
            newLabel={request.diffPreview.newLabel}
            unified={true}
            context={3}
          />
        </Box>
      ) : null}

      {request.shellDetails ? (
        <Box flexDirection="column" marginY={1}>
          <Box justifyContent="space-between">
            <Text dimColor>CWD: {request.shellDetails.cwd}</Text>
            <Text
              bold
              color={
                riskLevel === "critical"
                  ? theme.diff.removed
                  : riskLevel === "high"
                  ? theme.modes.ultrawork.secondary
                  : riskLevel === "medium"
                  ? theme.modes.ultrawork.primary
                  : theme.modes.build.primary
              }
            >
              RISK: {riskLevel.toUpperCase()}
            </Text>
          </Box>
          <Box
            borderStyle="single"
            borderColor={theme.border.passive}
            paddingX={1}
            marginY={0}
          >
            <Text color={theme.accent} bold>
              $ {request.shellDetails.command}
            </Text>
          </Box>
          {request.shellDetails.warning ? (
            <Text color={theme.diff.removed}>
              Warning: {request.shellDetails.warning}
            </Text>
          ) : null}
        </Box>
      ) : null}

      {!request.diffPreview && !request.shellDetails ? (
        <Box flexDirection="column" marginY={1}>
          <Text dimColor>Arguments:</Text>
          <Text>{JSON.stringify(request.args, null, 2)}</Text>
        </Box>
      ) : null}

      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.border.passive}
        paddingX={1}
        marginTop={0}
      >
        {feedbackMode ? (
          <Box flexDirection="column">
            <Text color={theme.accent} bold>
              Type rejection feedback or instructions:
            </Text>
            <Box>
              <Text color={theme.accent}>❯ </Text>
              <Text>{feedbackText}</Text>
              <Text inverse color={theme.accent}> </Text>
            </Box>
            <Text dimColor>
              Enter send feedback · Esc back
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {actions.map((action, index) => (
              <Text key={action.id}>
                <Text color={index === clamped ? theme.accent : theme.muted}>
                  {index === clamped ? "❯ " : "  "}
                </Text>
                <Text bold={index === clamped} color={action.color}>
                  {action.label}
                </Text>
              </Text>
            ))}
            <Text dimColor>Up/Down move · Enter select · Esc deny</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
