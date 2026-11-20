import React from "react";
import { Box, Text } from "ink";

import { workerIsStalled, type SubagentWorkerState } from "../agent/subagent";
import type { TaskItem } from "../agent/task-board";
import { agentActivitySummary, workerActive, workerActivity, workerTitle } from "./agent-activity";
import { displayWidth, fitDisplayText, singleLine } from "./text-wrap";
import { useActiveTheme } from "./theme";

interface SubagentStatusRow {
  id: string;
  text: string;
}

export function subagentStatusRows({
  workers,
  tasks,
  width,
  detailLimit,
}: {
  workers: SubagentWorkerState[];
  tasks: TaskItem[];
  width: number;
  detailLimit: number;
}): SubagentStatusRow[] {
  const summary = agentActivitySummary(workers, tasks, width);
  if (!summary) return [];

  const rows = [{ id: "summary", text: summary }];
  if (width < 30 || detailLimit <= 0) return rows;

  const separator = " · ";
  const separatorWidth = displayWidth(separator);
  const now = Date.now();
  const active = workers.filter(workerActive);
  for (const worker of active.slice(0, detailLimit)) {
    const activity = singleLine(workerActivity(worker));
    const detail = workerIsStalled(worker, now) ? `Stalled${separator}${activity}` : activity;
    const phase = fitDisplayText(detail, Math.ceil(width * 0.55));
    const title = fitDisplayText(workerTitle(worker), width - separatorWidth - displayWidth(phase));
    rows.push({ id: `worker:${worker.id}`, text: `${title}${separator}${phase}` });
  }
  return rows;
}

export function SubagentStatus({ rows }: { rows: SubagentStatusRow[] }): React.ReactElement | null {
  const theme = useActiveTheme();
  if (rows.length === 0) return null;
  return (
    <Box flexDirection="column">
      {rows.map(({ id, text }) => <Text key={id} color={theme.text} wrap="truncate">{text}</Text>)}
    </Box>
  );
}
