import type { ProgressCheckpointEvent } from "../types/schema";

export class TurnProgress {
  private lastCheckpoint = 0;

  constructor(readonly interval: number) {}

  checkpoint(input: { toolCalls: number; step: number; elapsedMs: number }): ProgressCheckpointEvent | undefined {
    if (this.interval === 0 || input.toolCalls - this.lastCheckpoint < this.interval) return undefined;
    this.lastCheckpoint = input.toolCalls;
    return {
      type: "progress_checkpoint",
      tool_calls: input.toolCalls,
      step: input.step,
      elapsed_ms: input.elapsedMs,
      interval: this.interval,
    };
  }
}
