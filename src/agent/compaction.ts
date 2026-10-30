import { COMPACT_LABEL, estimateMessageTokens } from "../memory/hindsight";
import type { LLMProvider } from "../provider/router";
import { ChatRequestSchema, type Message, type TextBlock, type ToolDefinition } from "../types/schema";
import { estimateTokenCost } from "./token-estimate";

export { COMPACT_LABEL };

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_KEEP_TOKENS = 15_000;
/** Room kept free for the reply: 15% of the window, at least 16k on normal windows. */
const RESERVE_SHARE = 0.15;
const RESERVE_MIN = 16_000;
const TRIM_KEEP_CHARS = 2_000;

const SUMMARY_SYSTEM = [
  "You compress conversation history for a coding agent.",
  "Produce a compact Markdown summary that lets another agent continue the work.",
  "Use these sections: ## Objective, ## Requirements, ## Decisions, ## Completed, ## Active, ## Active Skills, ## Blockers, ## Next Move, ## Relevant Files.",
  "Keep decisions, conventions, exact file paths, and active todo items with their status.",
  "Keep loaded skill IDs and their absolute paths in the Active Skills section. Never copy full skill bodies into the summary.",
  "Drop chit-chat, tool noise, and stale intermediate output.",
  "If a previous summary is provided, merge it with the new conversation and keep it current.",
].join(" ");

export interface PrecomputedCompaction {
  summary: string;
  olderIds: string[];
  previousSummary?: string;
  keepTokens: number;
  createdAt: number;
}

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
  /** Measured prompt tokens from the provider, when one is known. */
  contextTokens?: number;
  /** Prompt budget for this request. Wins over the context window minus reserve. */
  inputBudget?: number;
  maxSummaryTokens?: number;
  signal?: AbortSignal;
  onStart?: () => void;
  /** Summary prepared earlier in the background, reused when the older set matches. */
  precomputed?: PrecomputedCompaction;
}


export function compactionReserve(window: number, options: { bufferTokens?: number; bufferRatio?: number; reserveTokens?: number; outputLimit?: number } = {}): number {
  if (options.reserveTokens !== undefined) return options.reserveTokens;
  if (options.bufferTokens !== undefined) return options.bufferTokens;
  if (options.bufferRatio !== undefined) return Math.floor(window * options.bufferRatio);
  const share = Math.floor(window * RESERVE_SHARE);
  // A window too small for a 16k reply keeps the share instead, so compaction
  // still has a budget left to work with.
  return window >= 2 * RESERVE_MIN ? Math.max(share, RESERVE_MIN) : share;
}

/**
 * The prompt budget for one request. Reserve the output the request asks for and
 * a small safety margin, so the request never sits exactly on the window edge.
 */
export function computeInputBudget(input: {
  contextWindow: number;
  maxInput?: number;
  maxOutput?: number;
  requestedOutput?: number;
  reserved?: number;
  safetyRatio?: number;
}): number {
  const base = Math.min(input.maxInput ?? input.contextWindow, input.contextWindow);
  const output = Math.max(1024, input.requestedOutput ?? input.maxOutput ?? 32_000);
  const reserved = Math.max(1024, input.reserved ?? compactionReserve(base));
  const safety = Math.max(2_048, Math.floor(base * (input.safetyRatio ?? 0.02)));
  return Math.max(1_024, base - Math.max(output, reserved) - safety);
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
  return estimateTokenCost(text);
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
 * Picks where the retained recent conversation starts: drop the oldest
 * messages until the rest fit the keep budget, prefer a user-message boundary
 * so a turn stays together, and when everything fits keep only the latest
 * exchange so manual compaction still has an older part to summarize. A single
 * turn that is larger than the budget is split instead of kept whole, which is
 * what an oversized tool result looks like.
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

export interface CompactionParts {
  systems: Message[];
  tail: Message[];
  older: Message[];
}

/**
 * Splits a conversation into the fixed system messages, the recent tail kept
 * verbatim, and the older messages that a summary replaces. The tail never
 * starts on a tool result, because the summary would then remove the call that
 * produced it.
 */
export function selectCompactionParts(
  messages: Message[],
  keepTokens = DEFAULT_KEEP_TOKENS,
): CompactionParts {
  const systems = messages.filter(
    (message) => message.role === "system" && !isSummaryMessage(message),
  );
  const conversation = messages.filter((message) => message.role !== "system");
  const { tail: rawTail, older } = selectTail(conversation, keepTokens);
  const tail = [...rawTail];
  while (tail.length > 0 && tail[0]?.role === "tool") {
    const previous = older.pop();
    if (!previous) break;
    tail.unshift(previous);
  }
  return { systems, tail, older };
}

/**
 * Writes the summary for the current older messages without changing the
 * conversation. The orchestrator holds the result until compaction is due, so
 * the pause at the threshold is shorter.
 */
export async function precomputeCompaction(
  messages: Message[],
  options: CompactionOptions,
): Promise<PrecomputedCompaction | undefined> {
  const keepTokens = options.keepTokens ?? DEFAULT_KEEP_TOKENS;
  const { older } = selectCompactionParts(messages, keepTokens);
  if (older.length === 0) return undefined;
  const previousSummary = options.previousSummary ?? extractSummary(messages);
  const summary = await summarize(
    older,
    options.provider,
    previousSummary,
    options.maxSummaryTokens ?? 2000,
    options.signal,
  );
  return {
    summary,
    olderIds: older.map((message) => message.id),
    previousSummary,
    keepTokens,
    createdAt: Date.now(),
  };
}

export interface PruneResult {
  messages: Message[];
  prunedTokens: number;
  prunedResults: number;
  prunedMessageIds: string[];
}

export const PRUNED_TOOL_RESULT =
  "[context pruned: old tool output removed to save room. Run the command or read the file again if the detail is needed.]";

function toolResultText(content: string | TextBlock[]): string {
  return typeof content === "string" ? content : content.map((block) => block.text).join("\n");
}

/**
 * Removes tool output the model no longer needs. Walks backwards, keeps the
 * newest tool results up to the protect budget, and leaves the most recent turns
 * untouched. Nothing changes unless the freed amount passes the minimum.
 */
export function pruneToolOutput(
  messages: Message[],
  options: { protectTokens?: number; minTokens?: number; keepTurns?: number } = {},
): PruneResult {
  const protectTokens = options.protectTokens ?? 40_000;
  const minTokens = options.minTokens ?? 20_000;
  const keepTurns = Math.max(1, options.keepTurns ?? 2);

  let turns = 0;
  let boundary = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    turns += 1;
    if (turns >= keepTurns) {
      boundary = index;
      break;
    }
  }
  if (boundary <= 0) return { messages, prunedTokens: 0, prunedResults: 0, prunedMessageIds: [] };

  let protectedTokens = 0;
  const targets: Array<{ messageIndex: number; blockIndex: number; messageId: string; tokens: number }> = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (index >= boundary) continue;
    const message = messages[index];
    if (message.role !== "tool") continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.content[blockIndex];
      if (block.type !== "tool_result") continue;
      const text = toolResultText(block.content);
      if (text.startsWith("[context pruned:")) continue;
      const tokens = estimateTextTokens(text);
      if (protectedTokens + tokens <= protectTokens) {
        protectedTokens += tokens;
        continue;
      }
      targets.push({ messageIndex: index, blockIndex, messageId: message.id, tokens });
    }
  }

  const total = targets.reduce((sum, target) => sum + target.tokens, 0);
  if (total < minTokens) return { messages, prunedTokens: 0, prunedResults: 0, prunedMessageIds: [] };

  const next = messages.map((message) => ({ ...message, content: [...message.content] }));
  let prunedTokens = 0;
  const prunedMessageIds = new Set<string>();
  for (const target of targets) {
    const message = next[target.messageIndex];
    const block = message?.content[target.blockIndex];
    if (block?.type !== "tool_result") continue;
    message.content[target.blockIndex] = { ...block, content: PRUNED_TOOL_RESULT };
    prunedTokens += target.tokens;
    prunedMessageIds.add(target.messageId);
  }
  return {
    messages: next,
    prunedTokens,
    prunedResults: targets.length,
    prunedMessageIds: [...prunedMessageIds].sort(),
  };
}

export function markPrunedToolResults(
  messages: Message[],
  messageIds: readonly string[],
): Message[] {
  const ids = new Set(messageIds);
  if (ids.size === 0) return messages;
  return messages.map((message) =>
    ids.has(message.id)
      ? {
          ...message,
          content: message.content.map((block) =>
            block.type === "tool_result"
              ? { ...block, content: PRUNED_TOOL_RESULT }
              : block,
          ),
        }
      : message,
  );
}

export async function compactMessages(messages: Message[], options: CompactionOptions): Promise<CompactionResult> {
  const contextWindow = options.inputLimit ?? options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const buffer = compactionReserve(contextWindow, options);
  const overhead = options.overheadTokens ?? 0;
  const estimatedTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + overhead;
  const beforeTokens = options.contextTokens ?? estimatedTokens;
  const trigger = options.inputBudget ?? Math.max(1024, contextWindow - buffer);

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

  const previousSummary = options.previousSummary ?? extractSummary(messages);
  const { systems, tail, older } = selectCompactionParts(
    messages,
    options.keepTokens ?? DEFAULT_KEEP_TOKENS,
  );

  if (older.length === 0) {
    // Nothing older to summarize. An oversized tool result is still survivable:
    // trim it down so the retry can fit, and report a compaction.
    const trimmed = trimTailToBudget(messages, trigger, overhead);
    const afterTokens =
      trimmed.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + overhead;
    if (afterTokens < beforeTokens) {
      return {
        messages: trimmed,
        didCompact: true,
        beforeTokens,
        afterTokens,
        summaryTokens: 0,
        removedMessages: 0,
      };
    }
    return {
      messages,
      didCompact: false,
      beforeTokens,
      afterTokens: beforeTokens,
      summaryTokens: 0,
      removedMessages: 0,
    };
  }

  options.onStart?.();
  const precomputed = options.precomputed;
  const reusePrecomputed =
    precomputed !== undefined &&
    precomputed.previousSummary === previousSummary &&
    precomputed.olderIds.length === older.length &&
    precomputed.olderIds.every((id, index) => id === older[index]?.id);
  const summary = reusePrecomputed
    ? precomputed.summary
    : await summarize(
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
  const nextMessages = trimTailToBudget(
    [...systems, summaryMessage, ...tail],
    trigger,
    overhead,
  );
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

/**
 * Trims tool results that survived the cut so the compacted prompt always fits.
 * Without this, one oversized result keeps the request above the window and the
 * turn dies even though compaction “succeeded”.
 */
function trimTailToBudget(messages: Message[], budget: number, overhead: number): Message[] {
  const total = (value: Message[]): number =>
    value.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + overhead;
  const tokens = total(messages);
  if (tokens <= budget) return messages;

  const needChars = Math.ceil((tokens - budget) * 4 * 1.2);
  let freed = 0;
  return messages.map((message) => {
    if (freed >= needChars) return message;
    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== "tool_result" || freed >= needChars) return block;
      const text =
        typeof block.content === "string"
          ? block.content
          : block.content.map((item) => item.text).join("\n");
      const keep = TRIM_KEEP_CHARS;
      if (text.length <= keep * 2) return block;
      const removed = text.length - keep * 2;
      freed += removed;
      changed = true;
      const head = text.slice(0, keep);
      const tail = text.slice(-keep);
      return {
        ...block,
        content: `${head}\n\n[... ${removed} characters trimmed to fit the context window. Read the file again with offset or limit, or narrow the command, if the detail is needed.]\n\n${tail}`,
      };
    });
    return changed ? { ...message, content } : message;
  });
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
      if (text.startsWith("<skill_content")) {
        const name = /^<skill_content name="([^"]+)"/.exec(text)?.[1] ?? "unknown";
        const base = /Base directory for this skill:\s*(.+)/.exec(text)?.[1]?.trim();
        parts.push(`skill result: ${name}${base ? ` at ${base}` : ""}`);
      } else {
        parts.push(`tool result: ${truncate(text, 2000)}`);
      }
    } else if (block.type === "image") {
      parts.push(`[image: ${block.path ?? block.source.media_type}]`);
    }
  }
  return parts.join("\n");
}

function fallbackSummary(older: Message[]): string {
  const tools = new Set<string>();
  const files = new Set<string>();
  const skills = new Set<string>();
  for (const message of older) {
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      tools.add(block.name);
      if (block.name === "skill") {
        const id = (block.input as { id?: unknown }).id;
        if (typeof id === "string" && id.length > 0) skills.add(id);
      }
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
    "## Active Skills",
    skills.size > 0 ? [...skills].sort().join(", ") : "none recorded",
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
