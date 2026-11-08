import React from "react";
import { Text } from "ink";

import type { SubagentWorkerState } from "../agent/subagent";
import { summarizeSubagents, subagentStatusText } from "./format";
import { useActiveTheme } from "./theme";

export interface SubagentStatusProps {
  workers: SubagentWorkerState[];
  width: number;
}

/**
 * A calm, one-line activity indicator for background workers. The Agent Hub
 * remains the place for transcripts, task detail, and stop/steer actions.
 */
export function SubagentStatus({
  workers,
  width,
}: SubagentStatusProps): React.ReactElement | null {
  const theme = useActiveTheme();
  const summary = summarizeSubagents(workers);
  if (summary.active === 0) return null;
  const color =
    summary.running > 0
      ? theme.badge.running
      : summary.failed > 0
        ? theme.status.error
        : theme.muted;
  return (
    <Text color={color} wrap="truncate">
      {subagentStatusText(summary, width)}
    </Text>
  );
}
