import React from "react";
import { Box, Text, useInput } from "ink";

import type { SubagentWorkerState } from "../agent/subagent";
import type { TaskItem, TaskState } from "../agent/task-board";
import { getTheme, type Theme } from "./theme";

export type AgentHubTab = "workers" | "tasks";

export interface AgentHubProps {
  workers: SubagentWorkerState[];
  tasks?: TaskItem[];
  active?: boolean;
  initialTab?: AgentHubTab;
  onTabChange?: (tab: AgentHubTab) => void;
  onSteer: (workerId: string, instruction: string) => void;
  onKill: (workerId: string) => void;
  onCancelTask?: (id: string) => void;
  onDispatchTasks?: () => void;
  onMergeTask?: (id: string) => void;
  onExit: () => void;
  initialSelected?: number;
  width?: number;
  theme?: Theme;
}

function workerStatusColor(status: string, theme: Theme): string {
  if (status === "running" || status === "preparing" || status === "finalizing" || status === "queued") {
    return theme.badge.running;
  }
  if (status === "completed") return theme.badge.ok;
  if (status === "failed" || status === "timed_out") return theme.badge.error;
  return theme.badge.idle;
}

function taskStatusColor(state: TaskState, theme: Theme): string {
  if (state === "running") return theme.badge.running;
  if (state === "completed") return theme.badge.ok;
  if (state === "failed" || state === "blocked") return theme.badge.error;
  if (state === "cancelled") return theme.badge.idle;
  return theme.muted;
}

export function AgentHub({
  workers,
  tasks = [],
  active = true,
  initialTab = "workers",
  onTabChange,
  onSteer,
  onKill,
  onCancelTask,
  onDispatchTasks,
  onMergeTask,
  onExit,
  initialSelected = 0,
  width = 100,
  theme = getTheme("tokyonight"),
}: AgentHubProps) {
  const textLimit = Math.max(30, Math.floor(width * 0.5));
  const [tab, setTab] = React.useState<AgentHubTab>(initialTab);
  const [workerSelected, setWorkerSelected] = React.useState(Math.min(initialSelected, Math.max(workers.length - 1, 0)));
  const [taskSelected, setTaskSelected] = React.useState(0);
  const [steering, setSteering] = React.useState<string | null>(null);

  const workerIndex = workers.length === 0 ? -1 : Math.min(workerSelected, workers.length - 1);
  const currentWorker = workerIndex >= 0 ? workers[workerIndex] : undefined;
  const taskIndex = tasks.length === 0 ? -1 : Math.min(taskSelected, tasks.length - 1);
  const currentTask = taskIndex >= 0 ? tasks[taskIndex] : undefined;

  const selectTab = (next: AgentHubTab): void => {
    setTab(next);
    onTabChange?.(next);
  };

  useInput(
    (input, key) => {
      if (steering !== null) {
        if (key.return) {
          if (currentWorker && steering.trim().length > 0) onSteer(currentWorker.id, steering.trim());
          setSteering(null);
          return;
        }
        if (key.escape) {
          setSteering(null);
          return;
        }
        if (key.backspace || key.delete) {
          setSteering((value) => (value ?? "").slice(0, -1));
          return;
        }
        if (!key.ctrl && !key.meta && input.length > 0) {
          setSteering((value) => (value ?? "") + input);
        }
        return;
      }

      if (key.escape) {
        onExit();
        return;
      }
      if (key.tab) {
        selectTab(tab === "workers" ? "tasks" : "workers");
        return;
      }
      if (input === "w") {
        selectTab("workers");
        return;
      }
      if (input === "t") {
        selectTab("tasks");
        return;
      }

      if (tab === "workers") {
        if (key.upArrow) {
          setWorkerSelected((index) => Math.max(0, index - 1));
          return;
        }
        if (key.downArrow) {
          setWorkerSelected((index) => Math.min(Math.max(workers.length - 1, 0), index + 1));
          return;
        }
        if (input === "s" && currentWorker) {
          setSteering("");
          return;
        }
        if (input === "k" && currentWorker) {
          onKill(currentWorker.id);
        }
        return;
      }

      if (key.upArrow) {
        setTaskSelected((index) => Math.max(0, index - 1));
        return;
      }
      if (key.downArrow) {
        setTaskSelected((index) => Math.min(Math.max(tasks.length - 1, 0), index + 1));
        return;
      }
      if (input === "d") {
        onDispatchTasks?.();
        return;
      }
      if (input === "m" && currentTask) {
        onMergeTask?.(currentTask.id);
        return;
      }
      if (input === "x" && currentTask) {
        onCancelTask?.(currentTask.id);
      }
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Box gap={2}>
          <Text
            bold={tab === "workers"}
            color={tab === "workers" ? theme.accent : theme.muted}
          >
            Workers ({workers.length})
          </Text>
          <Text
            bold={tab === "tasks"}
            color={tab === "tasks" ? theme.accent : theme.muted}
          >
            Tasks ({tasks.length})
          </Text>
        </Box>
        <Text color={theme.muted}>Tab switch · Esc back</Text>
      </Box>
      <Text color={theme.border.passive}>{"─".repeat(48)}</Text>

      {tab === "workers" ? (
        <Box>
          <Box width="40%" flexDirection="column" paddingRight={1}>
            {workers.length === 0 ? <Text color={theme.muted}>(no workers yet)</Text> : null}
            {workers.map((worker, index) => {
              const color = workerStatusColor(worker.status, theme);
              const marker = index === workerIndex ? "❯" : " ";
              return (
                <Text key={worker.id} color={color} bold={index === workerIndex}>
                  {marker} {worker.id} [{worker.status}]
                </Text>
              );
            })}
          </Box>
          <Box width="60%" flexDirection="column" paddingLeft={1}>
            {currentWorker ? (
              <>
                <Text bold color={theme.text}>{currentWorker.id}</Text>
                <Text color={theme.muted}>task: {currentWorker.task.slice(0, textLimit)}</Text>
                <Text color={workerStatusColor(currentWorker.status, theme)}>status: {currentWorker.status}</Text>
                <Text color={theme.text}>
                  route: {currentWorker.provider && currentWorker.model
                    ? `${currentWorker.provider} / ${currentWorker.model}`
                    : currentWorker.roleModel ?? "main"}
                </Text>
                <Text color={theme.text}>worktree: {currentWorker.worktreePath ?? "(none)"}</Text>
                <Text color={theme.text}>
                  tokens: {currentWorker.usage
                    ? `${currentWorker.usage.prompt_tokens + currentWorker.usage.completion_tokens}`
                    : "0"}
                  {currentWorker.usage?.cost_usd !== undefined ? ` ($${currentWorker.usage.cost_usd.toFixed(4)})` : ""}
                </Text>
                <Text bold color={theme.modes.plan.primary}>Live transcript</Text>
                {currentWorker.transcript.length === 0 ? <Text color={theme.muted}>(empty)</Text> : null}
                {currentWorker.transcript.slice(-8).map((line, index) => (
                  <Text key={index} color={theme.muted}>
                    {line.length > textLimit ? `${line.slice(0, textLimit - 3)}...` : line}
                  </Text>
                ))}
              </>
            ) : (
              <Text color={theme.muted}>Select a subagent to inspect it.</Text>
            )}
          </Box>
        </Box>
      ) : (
        <Box>
          <Box width="45%" flexDirection="column" paddingRight={1}>
            {tasks.length === 0 ? (
              <Box flexDirection="column">
                <Text color={theme.muted}>No tasks yet.</Text>
                <Text color={theme.muted}>The agent creates them with task_create.</Text>
              </Box>
            ) : null}
            {tasks.map((task, index) => {
              const marker = index === taskIndex ? "❯" : " ";
              return (
                <Text key={task.id} color={taskStatusColor(task.state, theme)} bold={index === taskIndex}>
                  {marker} [{task.state}] {task.title.length > textLimit ? `${task.title.slice(0, textLimit - 3)}...` : task.title}
                </Text>
              );
            })}
          </Box>
          <Box width="55%" flexDirection="column" paddingLeft={1}>
            {currentTask ? (
              <>
                <Text bold color={theme.text}>{currentTask.title}</Text>
                <Text color={taskStatusColor(currentTask.state, theme)}>state: {currentTask.state}</Text>
                <Text color={theme.muted}>id: {currentTask.id}</Text>
                {currentTask.agent ? <Text color={theme.text}>agent: @{currentTask.agent}</Text> : null}
                <Text color={theme.text}>
                  route: {currentTask.provider && currentTask.model
                    ? `${currentTask.provider} / ${currentTask.model}`
                    : currentTask.roleModel ?? "main"}
                </Text>
                <Text color={theme.text}>deps: {currentTask.dependsOn.length > 0 ? currentTask.dependsOn.join(", ") : "none"}</Text>
                <Text color={theme.text}>worker: {currentTask.workerId ?? "not started"}</Text>
                {currentTask.error ? <Text color={theme.badge.error}>error: {currentTask.error}</Text> : null}
                {currentTask.filesChanged.length > 0 ? (
                  <Text color={theme.modes.plan.primary}>files: {currentTask.filesChanged.join(", ")}</Text>
                ) : null}
                {currentTask.merged !== undefined ? (
                  <Text color={currentTask.merged ? theme.badge.ok : theme.badge.error}>
                    {currentTask.merged ? `merged: ${currentTask.mergeSummary ?? "ok"}` : `merge failed: ${currentTask.mergeSummary ?? "conflict"}`}
                  </Text>
                ) : null}
                {currentTask.result ? (
                  <>
                    <Text bold color={theme.modes.plan.primary}>Result</Text>
                    {currentTask.result.split("\n").slice(0, 6).map((line, index) => (
                      <Text key={index} color={theme.text}>
                        {line.length > textLimit ? `${line.slice(0, textLimit - 3)}...` : line}
                      </Text>
                    ))}
                  </>
                ) : null}
                {currentTask.diff ? (
                  <>
                    <Text bold color={theme.modes.plan.primary}>Diff</Text>
                    {currentTask.diff.split("\n").slice(0, 8).map((line, index) => (
                      <Text key={index} color={line.startsWith("+") ? theme.diff.added : line.startsWith("-") ? theme.diff.removed : theme.muted}>
                        {line.length > textLimit ? `${line.slice(0, textLimit - 3)}...` : line}
                      </Text>
                    ))}
                  </>
                ) : null}
              </>
            ) : (
              <Text color={theme.muted}>Select a task to inspect it.</Text>
            )}
          </Box>
        </Box>
      )}

      <Text color={theme.muted}>
        {tab === "workers"
          ? "Up/Down move · s steer · k kill · Tab tasks · Esc back"
          : "Up/Down move · d dispatch ready · m merge · x cancel · Tab workers · Esc back"}
      </Text>
      {steering !== null ? (
        <Text color={theme.badge.running}>
          Steering {currentWorker?.id ?? ""} ❯ {steering} (Enter send, Esc cancel)
        </Text>
      ) : null}
    </Box>
  );
}
