import type { SessionCompaction } from "../memory/sqlite";
import type { AgentMode, Message } from "../types/schema";
import type { ChatEntryView } from "./app";

export function messageEntryText(message: Message): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join(" ");
}

export function compactionEntryView(
  compaction: SessionCompaction,
  id = `compaction-${compaction.created_at}`,
): ChatEntryView {
  return {
    id,
    role: "compaction",
    text: compaction.summary,
    compaction: {
      beforeTokens: compaction.before_tokens,
      afterTokens: compaction.after_tokens,
      removedMessages: compaction.removed_messages ?? 0,
      auto: compaction.auto,
      status: "done",
    },
  };
}

/**
 * Builds the visible transcript from the full message history and inserts the
 * compaction checkpoint before the retained tail, so the summary appears where
 * the context was compacted.
 */
export function buildTranscriptEntries(
  messages: Message[],
  compaction?: SessionCompaction,
): ChatEntryView[] {
  const entries: ChatEntryView[] = [];
  const tailId = compaction?.tail_start_message_id;
  const insertIndex = compaction ? (tailId ? messages.findIndex((message) => message.id === tailId) : 0) : -1;
  let inserted = false;

  const insertCompaction = (): void => {
    if (!compaction || inserted) return;
    entries.push(compactionEntryView(compaction));
    inserted = true;
  };

  messages.forEach((message, index) => {
    if (index === (insertIndex === -1 ? 0 : insertIndex)) insertCompaction();
    const metadata = message.metadata;
    const modeValue = metadata?.mode;
    const mode: AgentMode | undefined =
      modeValue === "plan" || modeValue === "build" || modeValue === "ultrawork"
        ? modeValue
        : undefined;
    const model = typeof metadata?.model === "string" ? metadata.model : undefined;
    const tokensPerSecond =
      typeof metadata?.tokens_per_second === "number" &&
      Number.isFinite(metadata.tokens_per_second)
        ? metadata.tokens_per_second
        : undefined;
    entries.push({
      id: `entry-${index + 1}`,
      role: message.role === "system" ? "system" : message.role === "assistant" ? "assistant" : "user",
      text: messageEntryText(message),
      ...(message.role === "assistant" && (mode || model || tokensPerSecond !== undefined)
        ? { mode, model, tokensPerSecond }
        : {}),
    });
  });

  if (!inserted) insertCompaction();
  return entries;
}
