import type { SessionCompaction } from "../memory/sqlite";
import type { AgentMode, Message } from "../types/schema";
import type { ChatEntryView, ChatToolCallView, ThinkingSegmentView } from "./app";

function thinkingSegmentsFromMetadata(value: unknown): ThinkingSegmentView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const segments = value.flatMap((entry): ThinkingSegmentView[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.text !== "string" || typeof record.startedAt !== "number") return [];
    return [
      {
        id: typeof record.id === "string" ? record.id : `thinking-${record.startedAt}`,
        text: record.text,
        startedAt: record.startedAt,
        completedAt: typeof record.completedAt === "number" ? record.completedAt : undefined,
        toolIndex: typeof record.toolIndex === "number" ? record.toolIndex : 0,
      },
    ];
  });
  return segments.length > 0 ? segments : undefined;
}

function toolDiffFromMetadata(value: unknown): ChatToolCallView["diff"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.oldText !== "string" || typeof record.newText !== "string") return undefined;
  const action =
    record.action === "edit" ||
    record.action === "create" ||
    record.action === "delete" ||
    record.action === "move"
      ? record.action
      : undefined;
  return {
    oldText: record.oldText,
    newText: record.newText,
    oldLabel: typeof record.oldLabel === "string" ? record.oldLabel : undefined,
    newLabel: typeof record.newLabel === "string" ? record.newLabel : undefined,
    additions: typeof record.additions === "number" ? record.additions : undefined,
    deletions: typeof record.deletions === "number" ? record.deletions : undefined,
    action,
  };
}

function toolCallsFromMetadata(value: unknown): ChatToolCallView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls = value.flatMap((entry): ChatToolCallView[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string") return [];
    return [
      {
        id: typeof record.id === "string" ? record.id : `tool-${record.name}`,
        name: record.name,
        label: typeof record.label === "string" ? record.label : record.name,
        detail: typeof record.detail === "string" ? record.detail : undefined,
        filePath: typeof record.filePath === "string" ? record.filePath : undefined,
        command: typeof record.command === "string" ? record.command : undefined,
        output: typeof record.output === "string" ? record.output : undefined,
        diff: toolDiffFromMetadata(record.diff),
        argumentsSummary:
          typeof record.argumentsSummary === "string" ? record.argumentsSummary : "",
        status:
          record.status === "running" || record.status === "ok" || record.status === "error"
            ? record.status
            : undefined,
        durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
        lspStatus: typeof record.lspStatus === "string" ? record.lspStatus : undefined,
      },
    ];
  });
  return calls.length > 0 ? calls : undefined;
}

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
    // Tool calls and results are shown through the tool_calls metadata on the
    // answer entry, so their stored rows must not become empty chat bubbles.
    if (message.role === "tool") return;
    const hasToolUse = message.content.some((block) => block.type === "tool_use");
    if (message.role === "assistant" && hasToolUse && messageEntryText(message).trim().length === 0) return;
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
    const turnTokens =
      typeof metadata?.turn_tokens === "number" && Number.isFinite(metadata.turn_tokens)
        ? metadata.turn_tokens
        : undefined;
    const filesChanged =
      typeof metadata?.files_changed === "number" && Number.isFinite(metadata.files_changed)
        ? metadata.files_changed
        : undefined;
    const thinkingSegments = thinkingSegmentsFromMetadata(metadata?.thinking_segments);
    const toolCalls = toolCallsFromMetadata(metadata?.tool_calls);
    entries.push({
      id: `entry-${index + 1}`,
      role: message.role === "system" ? "system" : message.role === "assistant" ? "assistant" : "user",
      text: messageEntryText(message),
      ...(thinkingSegments
        ? {
            thinkingSegments,
            thinking: thinkingSegments.map((segment) => segment.text).join("\n"),
          }
        : {}),
      ...(toolCalls ? { toolCalls } : {}),
      ...(message.role === "assistant" &&
      (mode ||
        model ||
        tokensPerSecond !== undefined ||
        turnTokens !== undefined ||
        filesChanged !== undefined)
        ? { mode, model, tokensPerSecond, turnTokens, filesChanged }
        : {}),
    });
  });

  if (!inserted) insertCompaction();
  return entries;
}
