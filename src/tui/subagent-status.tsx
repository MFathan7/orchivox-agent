import React from "react";
import { Text } from "ink";

import type { SubagentWorkerState } from "../agent/subagent";
import type { TaskItem } from "../agent/task-board";
import { agentActivitySummary } from "./agent-activity";
import { useActiveTheme } from "./theme";

export interface SubagentStatusProps {
  workers: SubagentWorkerState[];
  width: number;
  tasks?: TaskItem[];
}

/**
 * A calm, one-line activity indicator for background workers. The Agent Hub
 * remains the place for transcripts, task detail, and stop/steer actions.
 */
export function SubagentStatus({
  workers,
  width,
  tasks = [],
}: SubagentStatusProps): React.ReactElement | null {
  const theme = useActiveTheme();
  const summary = agentActivitySummary(workers, tasks, width);
  if (!summary) return null;
  return (
    <Text color={theme.text} wrap="truncate">
      {summary}
    </Text>
  );
}
