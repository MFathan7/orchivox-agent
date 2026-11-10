import { workerIsStalled, type SubagentWorkerState } from "../agent/subagent";
import type { TaskItem } from "../agent/task-board";
import { fitDisplayText, singleLine } from "./text-wrap";

export type ActivityTone = "running" | "success" | "error" | "warning" | "muted";

export function workerActive(worker: SubagentWorkerState): boolean {
  return ["queued", "preparing", "running", "finalizing"].includes(worker.status);
}

export function taskNeedsMerge(task: TaskItem): boolean {
  return task.state === "completed" && task.merged !== true &&
    (task.requiresMerge ?? (task.writeIsolation && task.mode !== "plan"));
}

export function taskActivity(task: TaskItem, tasks: TaskItem[]): { label: string; tone: ActivityTone; waitingOn: string[] } {
  const waitingOn = task.dependsOn.filter((id) => {
    const dependency = tasks.find((item) => item.id === id);
    return dependency && taskNeedsMerge(dependency);
  });
  if (task.state === "completed" && task.merged === false) return { label: "Merge failed", tone: "error", waitingOn: [] };
  if (taskNeedsMerge(task) || (task.state === "pending" && waitingOn.length > 0)) {
    return { label: "Awaiting merge", tone: "warning", waitingOn };
  }
  const labels = { pending: task.dependsOn.length ? "Waiting for dependency" : "Queued", running: "Running", completed: "Completed", failed: "Failed", blocked: "Blocked", cancelled: "Cancelled" };
  const tone: ActivityTone = task.state === "running" ? "running" : task.state === "completed" ? "success" : ["failed", "blocked"].includes(task.state) ? "error" : "muted";
  return { label: labels[task.state], tone, waitingOn: [] };
}

export function workerTitle(worker: SubagentWorkerState): string {
  return singleLine(worker.description?.trim() || worker.task.split("\n")[0] || worker.id);
}

export function workerTranscript(chunks: string[]): string {
  return chunks.map((chunk) => chunk.startsWith("[tool]") || chunk.startsWith("[skills]") || chunk.startsWith("steering:")
    ? `\n${chunk}\n` : chunk).join("").trim();
}

export function workerActivity(worker: SubagentWorkerState): string {
  if (worker.detail) return worker.detail;
  if (worker.phase) return worker.phase;
  const tool = [...worker.transcript].reverse().find((chunk) => chunk.startsWith("[tool] "));
  return tool ? tool.slice(7) : worker.status === "running" ? "Thinking" : worker.status;
}

export function workerModelLabel(
  worker: Pick<SubagentWorkerState, "provider" | "model" | "roleModel" | "route">,
): string {
  if (worker.route) {
    return `${worker.route.provider} / ${worker.route.model}${worker.route.fallback ? " (fallback)" : ""}`;
  }
  if (worker.provider && worker.model) return `${worker.provider} / ${worker.model}`;
  return worker.roleModel ? `${worker.roleModel} (unresolved)` : "Unresolved";
}

export function agentActivityCounts(workers: SubagentWorkerState[], tasks: TaskItem[]): { active: number; failed: number } {
  const active = workers.filter(workerActive).length;
  const failedWorkers = workers.filter((worker) => worker.status === "failed" || worker.status === "timed_out");
  const failedIds = new Set(failedWorkers.map((worker) => worker.id));
  const failed = failedWorkers.length + tasks.filter((task) =>
    (task.state === "failed" || task.merged === false) && (!task.workerId || !failedIds.has(task.workerId))).length;
  return { active, failed };
}

export function agentActivitySummary(workers: SubagentWorkerState[], tasks: TaskItem[], width: number): string {
  const { active, failed } = agentActivityCounts(workers, tasks);
  const stalled = workers.filter((worker) => workerIsStalled(worker)).length;
  const merge = tasks.filter(taskNeedsMerge).length;
  if (active + failed + merge === 0) return "";
  const parts = [
    active ? `${active} active${stalled ? ` (${stalled} stalled)` : ""}` : "",
    merge ? `${merge} ${width < 60 ? "merge" : "awaiting merge"}` : "",
    failed ? `${failed} failed` : "",
  ].filter(Boolean);
  const hint = width >= 70 ? " · /hub details" : "";
  return fitDisplayText(`Agents ${parts.join(" · ")}${hint}`, width);
}
