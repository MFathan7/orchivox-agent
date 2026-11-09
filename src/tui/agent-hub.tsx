import React from "react";
import { Box, Text, useInput } from "ink";

import type { SubagentWorkerState } from "../agent/subagent";
import type { TaskItem } from "../agent/task-board";
import { taskActivity, taskNeedsMerge, workerActive, workerActivity, workerTitle, workerTranscript, workerModelLabel, type ActivityTone } from "./agent-activity";
import { formatElapsed } from "./format";
import { isMouseSequence } from "./mouse";
import { displayWidth, fitDisplayText, graphemeClusters, wrapText } from "./text-wrap";
import { useActiveTheme, type Theme } from "./theme";

export type AgentHubTab = "workers" | "tasks";

export interface AgentHubProps {
  workers: SubagentWorkerState[];
  tasks?: TaskItem[];
  active?: boolean;
  initialTab?: AgentHubTab;
  onTabChange?: (tab: AgentHubTab) => void;
  onSteer: (workerId: string, instruction: string) => void;
  onKill: (workerId: string) => void;
  onKillAll?: () => void;
  onCancelTask?: (id: string) => void;
  onDispatchTasks?: () => void;
  onMergeTask?: (id: string) => void;
  onExit: () => void;
  initialSelected?: number;
  width?: number;
  height?: number;
  theme?: Theme;
}

interface DetailRow { text: string; tone?: ActivityTone; bold?: boolean }

function toneColor(tone: ActivityTone | undefined, theme: Theme): string {
  if (tone === "running") return theme.badge.running;
  if (tone === "muted") return theme.muted;
  return tone ? theme.status[tone] : theme.text;
}

function workerTone(worker: SubagentWorkerState): ActivityTone {
  return workerActive(worker) ? "running" : worker.status === "completed" ? "success" :
    worker.status === "failed" || worker.status === "timed_out" ? "error" : "muted";
}

export function AgentHub(props: AgentHubProps) {
  const { workers, tasks = [], active = true, width = 100, height = 24 } = props;
  const theme = useActiveTheme(props.theme);
  const [tab, setTab] = React.useState<AgentHubTab>(props.initialTab ?? "workers");
  const [workerId, setWorkerId] = React.useState(workers[props.initialSelected ?? 0]?.id);
  const [taskId, setTaskId] = React.useState(tasks[0]?.id);
  const [steering, setSteering] = React.useState<string | null>(null);
  const [detailOffset, setDetailOffset] = React.useState(0);
  const workerIndex = Math.max(0, workers.findIndex((worker) => worker.id === workerId));
  const taskIndex = Math.max(0, tasks.findIndex((task) => task.id === taskId));
  const currentWorker = workers[workerIndex];
  const currentTask = tasks[taskIndex];
  const canSteer = Boolean(currentWorker && workerActive(currentWorker));
  const canCancel = Boolean(currentTask && ["pending", "running", "blocked"].includes(currentTask.state));
  const canMerge = Boolean(currentTask && taskNeedsMerge(currentTask) && props.onMergeTask);
  const safeWidth = Math.max(1, width);
  const contentWidth = Math.max(1, safeWidth - 2);
  const wide = safeWidth >= 100;
  const listWidth = wide ? Math.floor(contentWidth * 0.4) : contentWidth;
  const detailWidth = wide ? contentWidth - listWidth - 2 : contentWidth;
  const actions = tab === "workers"
    ? [canSteer ? "s steer · k stop" : "", workers.some(workerActive) && props.onKillAll ? "K stop all" : ""].filter(Boolean)
    : [tasks.some((task) => task.state === "pending") && props.onDispatchTasks ? "d dispatch" : "", canMerge ? "m merge" : "", canCancel && props.onCancelTask ? "x cancel" : ""].filter(Boolean);
  const footer = wrapText(["↑↓ select · Tab switch · Esc back", "PgUp/PgDn detail", ...actions].join(" · "), contentWidth);
  const bodyHeight = Math.max(0, height - 2 - footer.length - (steering !== null ? 1 : 0));
  const items = tab === "workers" ? workers : tasks;
  const selectedIndex = tab === "workers" ? workerIndex : taskIndex;
  const listHeight = wide ? bodyHeight : Math.min(Math.max(1, items.length), Math.max(1, Math.floor((bodyHeight - 1) * 0.4)));
  const detailHeight = Math.max(0, wide ? bodyHeight : bodyHeight - listHeight - 1);
  const listStart = Math.max(0, Math.min(selectedIndex - listHeight + 1, Math.max(0, items.length - listHeight)));
  const details: DetailRow[] = [];
  const add = (text: string, tone?: ActivityTone, bold?: boolean) => details.push({ text, tone, bold });

  if (tab === "workers" && currentWorker) {
    const worker = currentWorker;
    add(workerTitle(worker), undefined, true);
    const end = worker.result?.finished_at ?? (workerActive(worker) ? Date.now() : worker.updatedAt);
    add(`${worker.status} · ${formatElapsed(Math.max(0, (end - worker.createdAt) / 1000))}`, workerTone(worker));
    add(`Activity: ${workerActivity(worker)}`);
    if (worker.lastProgressAt !== undefined) add(`Last progress: ${formatElapsed((Date.now() - worker.lastProgressAt) / 1000)} ago`, "muted");
    add(`Time limit: ${worker.timeoutSeconds ? `${worker.timeoutSeconds}s` : "Off"}`, "muted");
    if (worker.agent) add(`Agent: @${worker.agent}`);
    if (worker.error) add(`Error: ${worker.error.message}`, "error");
    if (worker.result?.output) { add("Result", undefined, true); add(worker.result.output); }
    add("Transcript", undefined, true);
    add(workerTranscript(worker.transcript) || "No activity recorded yet.", "muted");
    add("Technical details", undefined, true);
    add(`ID: ${worker.id}`, "muted");
    add(`Model: ${workerModelLabel(worker)}`, "muted");
    add(`Worktree: ${worker.worktreePath ?? "Shared workspace"}`, "muted");
    if (worker.usage) add(`Tokens: ${worker.usage.prompt_tokens + worker.usage.completion_tokens}${worker.usage.cost_usd === undefined ? "" : ` · $${worker.usage.cost_usd.toFixed(4)}`}`, "muted");
  } else if (tab === "tasks" && currentTask) {
    const task = currentTask;
    const activity = taskActivity(task, tasks);
    add(task.title, undefined, true);
    add(activity.label, activity.tone);
    if (activity.waitingOn.length) add(`Review and merge: ${activity.waitingOn.join(", ")}`, "warning");
    else if (taskNeedsMerge(task)) add("Review this result, then press m to merge.", "warning");
    if (task.agent) add(`Agent: @${task.agent}`);
    if (task.error) add(`Error: ${task.error}`, "error");
    if (task.mergeSummary) add(`Merge: ${task.mergeSummary}`, task.merged ? "success" : "error");
    if (task.result) { add("Result", undefined, true); add(task.result); }
    if (task.filesChanged.length) add(`Files: ${task.filesChanged.join(", ")}`);
    if (task.diff) { add("Diff", undefined, true); add(task.diff, "muted"); }
    add("Technical details", undefined, true);
    add(`ID: ${task.id}`, "muted");
    add(`Dependencies: ${task.dependsOn.join(", ") || "None"}`, "muted");
    add(`Worker: ${task.workerId ?? "Not started"}`, "muted");
    add(`Model: ${workerModelLabel(workers.find((worker) => worker.id === task.workerId) ?? task)}`, "muted");
  } else {
    add(tab === "workers" ? "No workers yet." : "No tasks yet.", "muted");
    add("Delegated work will appear here.", "muted");
  }
  const detailLines = details.flatMap((row) => wrapText(row.text, Math.max(1, detailWidth)).map((text) => ({ ...row, text })));
  const offset = Math.min(detailOffset, Math.max(0, detailLines.length - detailHeight));
  const selectTab = (next: AgentHubTab) => { setTab(next); setDetailOffset(0); setSteering(null); props.onTabChange?.(next); };

  useInput((input, key) => {
    if (isMouseSequence(input)) return;
    if (steering !== null) {
      if (key.escape) { setSteering(null); return; }
      if (key.return) {
        if (canSteer && steering.trim()) props.onSteer(currentWorker!.id, steering.trim());
        setSteering(null); return;
      }
      if (key.backspace || key.delete) setSteering((value) => graphemeClusters(value ?? "").slice(0, -1).join(""));
      else if (!key.ctrl && !key.meta) setSteering((value) => (value ?? "") + input);
      return;
    }
    if (key.escape) { props.onExit(); return; }
    if (key.tab) { selectTab(tab === "workers" ? "tasks" : "workers"); return; }
    if (input === "w" || input === "t") { selectTab(input === "w" ? "workers" : "tasks"); return; }
    if (key.pageUp || key.pageDown) {
      setDetailOffset(Math.max(0, Math.min(detailLines.length - detailHeight, offset + (key.pageUp ? -1 : 1) * Math.max(1, detailHeight - 1))));
      return;
    }
    if (key.upArrow || key.downArrow) {
      const index = Math.max(0, Math.min(items.length - 1, selectedIndex + (key.upArrow ? -1 : 1)));
      if (tab === "workers") setWorkerId(workers[index]?.id);
      else setTaskId(tasks[index]?.id);
      setDetailOffset(0); return;
    }
    if (tab === "workers") {
      if (input === "s" && canSteer) setSteering("");
      if (input === "k" && canSteer) props.onKill(currentWorker!.id);
      if (input === "K" && workers.some(workerActive)) props.onKillAll?.();
    } else {
      if (input === "d" && tasks.some((task) => task.state === "pending")) props.onDispatchTasks?.();
      if (input === "m" && canMerge) props.onMergeTask?.(currentTask!.id);
      if (input === "x" && canCancel) props.onCancelTask?.(currentTask!.id);
    }
  }, { isActive: active });

  const list = <Box width={listWidth} height={listHeight} overflow="hidden" flexDirection="column">
    {!items.length ? <Text color={theme.muted}>{tab === "workers" ? "No workers yet." : "No tasks yet."}</Text> : null}
    {items.slice(listStart, listStart + listHeight).map((item, index) => {
      const selected = listStart + index === selectedIndex;
      const worker = tab === "workers" ? item as SubagentWorkerState : undefined;
      const task = tab === "tasks" ? item as TaskItem : undefined;
      const status = task ? taskActivity(task, tasks) : { label: worker!.status, tone: workerTone(worker!) };
      const title = worker ? `${worker.agent ? `@${worker.agent} ` : ""}${workerTitle(worker)}` : task!.title;
      const statusWidth = Math.min(displayWidth(status.label), Math.floor(listWidth * 0.6));
      const label = fitDisplayText(status.label, statusWidth);
      return <Text key={item.id} wrap="truncate"><Text color={selected ? theme.focus : theme.muted}>{selected ? "❯ " : "  "}</Text><Text color={selected ? theme.selection : theme.text} bold={selected}>{fitDisplayText(title, Math.max(1, listWidth - statusWidth - 3))}</Text><Text color={toneColor(status.tone, theme)}> {label}</Text></Text>;
    })}
  </Box>;
  const detail = <Box width={detailWidth} height={detailHeight} overflow="hidden" flexDirection="column">
    {detailLines.slice(offset, offset + detailHeight).map((line, index) => <Text key={index} color={toneColor(line.tone, theme)} bold={line.bold} wrap="truncate">{line.text}</Text>)}
  </Box>;
  return <Box width={safeWidth} height={height} paddingX={safeWidth > 2 ? 1 : 0} overflow="hidden" flexDirection="column">
    <Text wrap="truncate"><Text bold color={tab === "workers" ? theme.selection : theme.muted}>{tab === "workers" ? "❯ " : "  "}Workers {workers.length}</Text>{"   "}<Text bold color={tab === "tasks" ? theme.selection : theme.muted}>{tab === "tasks" ? "❯ " : "  "}Tasks {tasks.length}</Text></Text>
    <Text color={theme.border.passive}>{"─".repeat(contentWidth)}</Text>
    <Box height={bodyHeight} flexDirection={wide ? "row" : "column"} overflow="hidden">
      {list}
      {wide ? <Box width={2} /> : <Box height={1} />}
      {detail}
    </Box>
    {footer.map((line, index) => <Text key={index} color={theme.muted} wrap="truncate">{line}</Text>)}
    {steering !== null ? <Text color={theme.text} wrap="truncate">{fitDisplayText(`Steer: ${steering} (Enter send, Esc cancel)`, contentWidth)}</Text> : null}
  </Box>;
}
