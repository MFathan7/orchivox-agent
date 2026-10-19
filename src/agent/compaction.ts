import { COMPACT_LABEL, estimateMessageTokens } from "../memory/hindsight";
import type { LLMProvider } from "../provider/router";
import { ChatRequestSchema, type Message, type ToolDefinition } from "../types/schema";

export { COMPACT_LABEL };

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_KEEP_TOKENS = 15_000;

const SUMMARY_SYSTEM = [
  "You compress conversation history for a coding agent.",
  "Produce a compact Markdown summary that lets another agent continue the work.",
  "Use these sections: ## Objective, ## Requirements, ## Decisions, ## Completed, ## Active, ## Active Skills, ## Blockers, ## Next Move, ## Relevant Files.",
  "Keep decisions, conventions, exact file paths, and active todo items with their status.",
  "Drop chit-chat, tool noise, and stale intermediate output.",
  "If a previous summary is provided, merge it with the new conversation and keep it current.",
].join(" ");

export interface CompactionOptions {
  provider: LLMProvider;
  contextWindow?: number;
  inputLimit?: number;
  outputLimit?: number;
  keepTokens?: number;
  bufferTokens?: number;
  bufferRatio?: number;
  reserveTokens?: number;
  force?: boolean;
  previousSummary?: string;
  overheadTokens?: number;
  maxSummaryTokens?: number;
  signal?: AbortSignal;
}

const RESERVE_MIN = 16_000;

export function compactionReserve(window: number, options: { bufferTokens?: number; bufferRatio?: number; reserveTokens?: number; outputLimit?: number } = {}): number {
  if (options.reserveTokens !== undefined) return options.reserveTokens;
  if (options.bufferTokens !== undefined) return options.bufferTokens;
  if (options.bufferRatio !== undefined) return Math.floor(window * options.bufferRatio);
  const baseline = Math.max(Math.floor(window * 0.1), window >= 2 * RESERVE_MIN ? RESERVE_MIN : 0);
  const outputFloor = Math.min(options.outputLimit ?? 0, Math.floor(window * 0.5));
  return Math.max(baseline, outputFloor);
}

export interface CompactionResult {
  messages: Message[];
  didCompact: boolean;
  summary?: string;
  beforeTokens: number;
  afterTokens: number;
  summaryTokens: number;
  tailStartMessageId?: string;
  removedMessages: number;
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateToolsTokens(tools: ToolDefinition[]): number {
  if (tools.length === 0) return 0;
  return estimateTextTokens(JSON.stringify(tools));
}

export function extractSummary(messages: Message[]): string | undefined {
  const summary = messages.find(isSummaryMessage);
  if (!summary) return undefined;
  const text = summary.content
    .filter((block): block is Extract<Message["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return text.slice(COMPACT_LABEL.length).trim() || undefined;
}

function isSummaryMessage(message: Message): boolean {
  return (
    message.role === "system" &&
    message.content.some((block) => block.type === "text" && block.text.startsWith(COMPACT_LABEL))
  );
}

function selectTail(conversation: Message[], keepTokens: number): { tail: Message[]; older: Message[] } {
  if (conversation.length === 0) return { tail: [], older: [] };
  const start = recentStart(conversation, keepTokens);
  return { tail: conversation.slice(start), older: conversation.slice(0, start) };
}

/**
 * Picks where the retained recent conversation starts, mirroring opencode:
 * drop the oldest messages until the rest fit the keep budget, snap to a user
 * message so a turn stays together, and when everything fits keep only the
 * latest exchange so manual compaction still has an older part to summarize.
 */
function recentStart(conversation: Message[], keepTokens: number): number {
  let kept = 0;
  let start = conversation.length;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const cost = estimateMessageTokens(conversation[index]);
    if (start < conversation.length && kept + cost > keepTokens) break;
    kept += cost;
    start = index;
  }
  start = Math.min(start, conversation.length - 1);

  const boundary = lastUserIndex(conversation, start);
  if (boundary > 0) return boundary;

  const latestUser = lastUserIndex(conversation, conversation.length - 1);
  if (latestUser > 0) return latestUser;

  return conversation.length;
}

function lastUserIndex(conversation: Message[], maxIndex: number): number {
  const limit = Math.min(maxIndex, conversation.length - 1);
  for (let index = limit; index >= 0; index -= 1) {
    if (conversation[index].role === "user") return index;
  }
  return -1;
}

export async function compactMessages(messages: Message[], options: CompactionOptions): Promise<CompactionResult> {
  const contextWindow = options.inputLimit ?? options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const buffer = compactionReserve(contextWindow, options);
  const overhead = options.overheadTokens ?? 0;
  const beforeTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + overhead;
  const trigger = Math.max(1024, contextWindow - buffer);

  if (!options.force && beforeTokens <= trigger) {
    return {
      messages,
      didCompact: false,
      beforeTokens,
      afterTokens: beforeTokens,
      summaryTokens: 0,
      removedMessages: 0,
    };
  }

  const systems = messages.filter((message) => message.role === "system" && !isSummaryMessage(message));
  const conversation = messages.filter((message) => message.role !== "system");
  const previousSummary = options.previousSummary ?? extractSummary(messages);
  const { tail, older } = selectTail(conversation, options.keepTokens ?? DEFAULT_KEEP_TOKENS);

  if (older.length === 0) {
    return {
      messages,
      didCompact: false,
      beforeTokens,
      afterTokens: beforeTokens,
      summaryTokens: 0,
      removedMessages: 0,
    };
  }

  const summary = await summarize(
    older,
    options.provider,
    previousSummary,
    options.maxSummaryTokens ?? 2000,
    options.signal,
  );
  const summaryMessage: Message = {
    id: `compaction-${Date.now().toString(36)}`,
    role: "system",
    content: [{ type: "text", text: `${COMPACT_LABEL}\n${summary}` }],
    created_at: Date.now(),
  };
  const nextMessages = [...systems, summaryMessage, ...tail];
  const afterTokens = nextMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + overhead;

  return {
    messages: nextMessages,
    didCompact: true,
    summary,
    beforeTokens,
    afterTokens,
    summaryTokens: estimateMessageTokens(summaryMessage),
    tailStartMessageId: tail[0]?.id,
    removedMessages: older.length,
  };
}

async function summarize(
  older: Message[],
  provider: LLMProvider,
  previousSummary: string | undefined,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const transcript = older.map(formatMessageForSummary).join("\n");
  const prompt = [
    previousSummary ? `Previous summary:\n${previousSummary}` : "",
    `Conversation to merge:\n${truncate(transcript, 60_000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const request = ChatRequestSchema.parse({
    system: SUMMARY_SYSTEM,
    messages: [{ id: "compaction-request", role: "user", content: [{ type: "text", text: prompt }] }],
    max_tokens: maxTokens,
    temperature: 0.2,
  });

  try {
    let text = "";
    let streamError: string | undefined;
    for await (const event of provider.streamChat(request, signal)) {
      if (event.type === "token") text += event.text;
      else if (event.type === "error") streamError = event.message;
    }
    if (!streamError && text.trim().length > 0) return text.trim();
  } catch {
    // Fall through to the deterministic summary.
  }
  return fallbackSummary(older);
}

function formatMessageForSummary(message: Message): string {
  const parts: string[] = [`[${message.role}]`];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "thinking") parts.push(block.thinking);
    else if (block.type === "tool_use") {
      parts.push(`called ${block.name}(${truncate(JSON.stringify(block.input), 1000)})`);
    } else if (block.type === "tool_result") {
      const text = typeof block.content === "string" ? block.content : block.content.map((item) => item.text).join("\n");
      parts.push(`tool result: ${truncate(text, 2000)}`);
    } else if (block.type === "image") {
      parts.push(`[image: ${block.path ?? block.source.media_type}]`);
    }
  }
  return parts.join("\n");
}

function fallbackSummary(older: Message[]): string {
  const tools = new Set<string>();
  const files = new Set<string>();
  for (const message of older) {
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      tools.add(block.name);
      const input = block.input as { filePath?: unknown; path?: unknown };
      const candidate = input.filePath ?? input.path;
      if (typeof candidate === "string") files.add(candidate);
    }
  }
  return [
    "## Objective",
    "Continue the current task from the retained recent conversation.",
    "",
    "## Completed",
    `${older.length} earlier message(s) were compacted without model help.`,
    "",
    "## Relevant Files",
    files.size > 0 ? [...files].sort().map((file) => `- ${file}`).join("\n") : "none recorded",
    "",
    "## Next Move",
    "Review the recent conversation and continue the remaining work.",
    "",
    `Tools used: ${[...tools].sort().join(", ") || "none"}.`,
  ].join("\n");
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}
