import type { ChatToolCallView } from "./app";

/**
 * A turn can end while a tool row is still marked running, especially after a
 * provider failure. Finalize those rows so the transcript never shows a tool
 * that is still active after the turn stopped.
 */
export function finalizeToolCalls(calls: ChatToolCallView[] | undefined): ChatToolCallView[] {
  if (!calls || calls.length === 0) return [];
  let changed = false;
  const next = calls.map((call) => {
    if (call.status !== "running") return call;
    changed = true;
    return {
      ...call,
      status: "error" as const,
      output: call.output ?? "turn ended before this tool returned",
    };
  });
  return changed ? next : calls;
}
