import { z } from "zod";
import type { Message } from "../types/schema";
import type { ToolRegistry } from "../tools/registry";
import { currentTurnContext } from "./turn-context";

const Marker = z.object({ checkpointId: z.string().uuid() });

export function applyContextRewinds(input: Message[]): Message[] {
  let messages = [...input];
  for (const message of input) {
    if (message.role !== "tool") continue;
    const rewind = Marker.safeParse(message.metadata?.contextRewind);
    if (!rewind.success || message.content.some((block) => block.type === "tool_result" && block.is_error)) continue;
    const end = messages.findIndex((entry) => entry.id === message.id);
    let start = messages.findIndex((entry) => entry.role === "tool" && entry.metadata?.contextCheckpoint === rewind.data.checkpointId);
    if (start < 0 || end <= start) continue;
    let current = end;
    while (current > start && messages[current].role !== "assistant") current--;
    while (start + 1 < current && messages[start + 1].role !== "assistant") start++;
    const keep = new Set<string>();
    for (let index = start + 1; index < current; index++) {
      const entry = messages[index];
      if (entry.role === "user" || entry.role === "system") keep.add(entry.id);
      if (entry.role === "assistant" && entry.content.some((block) => block.type === "tool_use" && block.name === "skill")) {
        keep.add(entry.id);
        let result = index + 1;
        while (result < current && messages[result].role === "tool") keep.add(messages[result++].id);
      }
    }
    messages = [...messages.slice(0, start + 1), ...messages.slice(start + 1, current).filter((entry) => keep.has(entry.id)), ...messages.slice(current)];
  }
  return messages;
}

export class ContextCheckpoint {
  private active?: { id: string; callId: string };
  private pendingRewind?: string;

  begin(): string {
    if (this.active) throw new Error("A context checkpoint is already active; rewind it before starting another.");
    this.active = { id: crypto.randomUUID(), callId: currentTurnContext()!.toolCallId! };
    return this.active.id;
  }
  rewind(id: string): void {
    if (this.active?.id !== id) throw new Error("Checkpoint is unavailable in this turn or expired after compaction.");
    this.pendingRewind = currentTurnContext()!.toolCallId!;
  }
  invalidate(): void { this.active = undefined; this.pendingRewind = undefined; }
  decorate(callId: string, message: Message): void {
    if (message.content.some((block) => block.type === "tool_result" && block.is_error)) return;
    if (this.active?.callId === callId) message.metadata = { ...message.metadata, contextCheckpoint: this.active.id };
    if (this.pendingRewind === callId && this.active) message.metadata = { ...message.metadata, contextRewind: { checkpointId: this.active.id } };
  }
  finishTurn(messages: Message[]): Message[] {
    if (!this.pendingRewind) return messages;
    const rewound = applyContextRewinds(messages);
    this.invalidate();
    return rewound;
  }
}

export function registerContextTools(registry: ToolRegistry): void {
  const controls = () => {
    const controls = currentTurnContext()?.contextControl;
    if (!controls) throw new Error("Context checkpoint tools are only available to the main agent during a running turn.");
    return controls;
  };
  registry.register({ name: "context_checkpoint", description: "Mark the start of a bounded exploration in this turn. Later context_rewind replaces its intermediate assistant/tool messages with your evidence report. Does not snapshot or undo files. Only one checkpoint may be active; compaction expires it. Finish a started exploration with context_rewind before replying.",
    parameters: z.object({ purpose: z.string().min(1).max(1000) }), readOnly: true,
    execute: () => JSON.stringify({ checkpointId: controls().begin(), note: "Context only; files and usage are unchanged. Keep enough evidence in the rewind report." }),
  });
  registry.register({ name: "context_rewind", description: "Keep an evidence report and remove intermediate exploration from active model context after the current tool batch. Requires checkpointId from this turn. Saved transcript, user instructions, loaded skills, current tool results, file changes, and usage remain intact. No file undo.",
    parameters: z.object({ checkpointId: z.string().uuid(), report: z.string().min(1).max(16_000) }), readOnly: true,
    execute: (input) => {
      const args = input as { checkpointId: string; report: string };
      controls().rewind(args.checkpointId);
      return `Exploration report retained after context rewind:\n\n${args.report}`;
    },
  });
}
