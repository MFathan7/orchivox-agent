import React from "react";
import { Box, Text, useInput } from "ink";

import type { ApprovalDecision, ApprovalRequest } from "../agent/permissions";
import { DiffView } from "./diff-view";
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

    if (input === "y" || input === "Y") {
      onDecision({ approved: true, choice: "approve_once" });
      return;
    }

    if (input === "a" || input === "A") {
      onDecision({ approved: true, choice: "always_allow" });
      return;
    }

    if (input === "n" || input === "N" || key.escape) {
      onDecision({
        approved: false,
        choice: "deny",
        reason: "Tool execution cancelled by user.",
      });
      return;
    }

    if (input === "f" || input === "F") {
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
              <Text color={theme.accent}>&gt; </Text>
              <Text>{feedbackText}</Text>
              <Text inverse color={theme.accent}> </Text>
            </Box>
            <Text dimColor>
              Enter Send Feedback  |  Esc Cancel
            </Text>
          </Box>
        ) : (
          <Box justifyContent="space-between">
            <Box gap={2}>
              <Text color={theme.modes.build.primary} bold>
                y Approve Once
              </Text>
              <Text color={theme.modes.plan.primary} bold>
                a Always Allow
              </Text>
              <Text color={theme.diff.removed} bold>
                n Deny
              </Text>
              <Text color={theme.modes.ultrawork.primary} bold>
                f Deny with Feedback
              </Text>
            </Box>
            <Text dimColor>Select an action hotkey</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
