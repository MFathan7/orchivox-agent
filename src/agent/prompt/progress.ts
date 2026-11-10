import type { Message, ProgressCheckpointEvent } from "../../types/schema";

export function progressCheckpointMessage(runId: string, checkpoint: ProgressCheckpointEvent): Message {
  return {
    id: `${runId}-checkpoint-${checkpoint.tool_calls}`,
    role: "user",
    metadata: { synthetic: true, progress_checkpoint: true },
    content: [{ type: "text", text: [
      `Progress checkpoint: ${checkpoint.tool_calls} tool calls across ${checkpoint.step} model steps, ${Math.round(checkpoint.elapsed_ms / 1000)} seconds elapsed.`,
      "Review the original request and the evidence already collected before choosing your next action.",
      "Identify the requested outcomes that remain unresolved and the concrete evidence missing for each. A changed command or screenshot name alone does not establish new progress.",
      "If the requested work and required checks are complete, deliver the result now. If something remains, choose the focused action that will resolve it; batch independent work or use a worker when it helps.",
      "Repeat verification only for a relevant change, a failed check, or a specific uncertainty that the earlier result did not cover. Do not add acceptance criteria or repeat a worker's investigation.",
      "If you cannot make progress with the available tools or information, report the blocker and completed work honestly. Do not claim completion from call counts, an unchanged diff, or tool success alone.",
      "This checkpoint does not require an extra tool call, a status-only response, or continued work after completion.",
    ].join(" ") }],
  };
}
