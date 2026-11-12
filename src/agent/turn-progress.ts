import { createHash } from "node:crypto";
import type { ProgressCheckpointEvent, ToolResultBlock } from "../types/schema";
import { normalizeToolPath } from "./tool-call-tracker";

export class TurnProgress {
  private lastCheckpoint = 0;
  private readonly toolCounts = new Map<string, number>();
  private readonly readPaths = new Map<string, number>();
  private readonly results = new Set<string>();
  private fileChanges = 0;
  private errorResults = 0;
  private repeatedResults = 0;

  constructor(readonly interval: number) {}

  recordResult(tool: { name: string; readOnly: boolean; path?: string; root: string }, result: ToolResultBlock): void {
    if (this.interval === 0) return;
    this.toolCounts.set(tool.name, (this.toolCounts.get(tool.name) ?? 0) + 1);
    if (tool.readOnly && tool.path) {
      const path = normalizeToolPath(tool.path, tool.root);
      this.readPaths.set(path, (this.readPaths.get(path) ?? 0) + 1);
    }
    if (result.is_error) this.errorResults += 1;
    const digest = createHash("sha256")
      .update(JSON.stringify([tool.name, result.is_error, result.content]))
      .digest("hex");
    if (this.results.has(digest)) this.repeatedResults += 1;
    this.results.add(digest);
  }

  recordFileChange(): void {
    if (this.interval !== 0) this.fileChanges += 1;
  }

  checkpoint(input: { toolCalls: number; step: number; elapsedMs: number }): ProgressCheckpointEvent | undefined {
    if (this.interval === 0 || input.toolCalls - this.lastCheckpoint < this.interval) return undefined;
    this.lastCheckpoint = input.toolCalls;
    const activity = {
      tool_counts: Object.fromEntries([...this.toolCounts].sort((a, b) => b[1] - a[1])),
      read_paths: [...this.readPaths].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([path, calls]) => ({ path, calls })),
      file_changes: this.fileChanges,
      error_results: this.errorResults,
      repeated_results: this.repeatedResults,
    };
    this.toolCounts.clear();
    this.readPaths.clear();
    this.results.clear();
    this.fileChanges = 0;
    this.errorResults = 0;
    this.repeatedResults = 0;
    return {
      type: "progress_checkpoint",
      tool_calls: input.toolCalls,
      step: input.step,
      elapsed_ms: input.elapsedMs,
      interval: this.interval,
      activity,
    };
  }
}
