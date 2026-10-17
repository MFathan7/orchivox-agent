import { z } from "zod";

import type { LLMProvider } from "../provider/router";
import { ChatRequestSchema, type Message } from "../types/schema";
import type { AgentTool, ToolRegistry } from "../tools/registry";
import type { MemoryDatabase } from "./sqlite";

export const COMPACT_LABEL = "[COMPACTED SESSION SUMMARY]";
const COMPACT_THRESHOLD = 0.8;
const TAIL_TOKEN_FRACTION = 0.35;
const SUMMARY_SYSTEM_PROMPT = [
  "You compress conversation history for a coding agent.",
  "Reply with a compact plain-text summary.",
  "Keep decisions and conventions, every file path that was edited and why, and any active todo items with their status.",
  "Drop chit-chat, tool noise, and stale intermediate output.",
].join(" ");

export class HindsightMemory {
  private readonly database: MemoryDatabase;

  constructor(database: MemoryDatabase) {
    this.database = database;
  }

  registerTools(registry: ToolRegistry): void {
    registry.register(this.rememberInsightTool());
    registry.register(this.recallInsightsTool());
  }

  async compactMessagesIfNeeded(
    messages: Message[],
    maxContextTokens: number,
    provider: LLMProvider,
  ): Promise<Message[]> {
    const estimated = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    if (estimated <= maxContextTokens * COMPACT_THRESHOLD) return messages;

    const systemMessages = messages.filter((message) => message.role === "system");
    const conversation = messages.filter((message) => message.role !== "system");
    const tailBudget = Math.floor(maxContextTokens * TAIL_TOKEN_FRACTION);
    const tail: Message[] = [];
    let tailTokens = 0;
    for (let index = conversation.length - 1; index >= 0; index -= 1) {
      const cost = estimateMessageTokens(conversation[index]);
      if (tail.length >= 2 && tailTokens + cost > tailBudget) break;
      tail.unshift(conversation[index]);
      tailTokens += cost;
    }
    const older = conversation.slice(0, conversation.length - tail.length);
    if (older.length === 0) return messages;

    const summaryText = await this.summarize(older, provider);
    const summary: Message = {
      id: `compacted-${Date.now().toString(36)}`,
      role: "system",
      content: [{ type: "text", text: `${COMPACT_LABEL}\n${summaryText}` }],
      created_at: Date.now(),
    };
    return [...systemMessages, summary, ...tail];
  }

  private rememberInsightTool(): AgentTool {
    return {
      name: "remember_insight",
      description:
        "Store a long-term insight (architecture convention, past bug fix, decision) with optional file globs so future sessions can recall it.",
      parameters: z.object({
        topic: z.string().min(1),
        insight: z.string().min(1),
        file_patterns: z.array(z.string().min(1)).default([]),
      }),
      readOnly: false,
      execute: (args) => {
        const request = args as { topic: string; insight: string; file_patterns: string[] };
        const note = this.database.saveInsight({
          topic: request.topic,
          insight: request.insight,
          filePatterns: request.file_patterns,
        });
        return `remembered "${note.topic}" (${note.id})`;
      },
    };
  }

  private recallInsightsTool(): AgentTool {
    return {
      name: "recall_insights",
      description:
        "Recall long-term insights. Filters combine: query matches topic or insight text, file_path matches the stored file globs.",
      parameters: z.object({
        query: z.string().optional(),
        file_path: z.string().optional(),
        limit: z.number().int().positive().default(10),
      }),
      readOnly: true,
      execute: (args) => {
        const request = args as { query?: string; file_path?: string; limit: number };
        const candidates = request.query
          ? this.database.searchInsights(request.query, Math.max(request.limit, 50))
          : this.database.listInsights(Math.max(request.limit, 50));
        const matched = request.file_path
          ? candidates.filter((note) =>
              note.filePatterns.some((pattern) => new Bun.Glob(pattern).match(request.file_path as string)),
            )
          : candidates;
        const limited = matched.slice(0, request.limit);
        if (limited.length === 0) return "no stored insights match";
        return limited.map(formatNote).join("\n\n");
      },
    };
  }

  private async summarize(older: Message[], provider: LLMProvider): Promise<string> {
    const transcript = older.map(formatMessageForSummary).join("\n");
    const request = ChatRequestSchema.parse({
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [
        {
          id: "compact-request",
          role: "user",
          content: [{ type: "text", text: `Summarize this conversation:\n\n${truncate(transcript, 60_000)}` }],
        },
      ],
      max_tokens: 1000,
    });

    try {
      let text = "";
      let streamError: string | undefined;
      for await (const event of provider.streamChat(request)) {
        if (event.type === "token") text += event.text;
        else if (event.type === "error") streamError = event.message;
      }
      if (!streamError && text.trim().length > 0) return text.trim();
    } catch {
      // fall through to the deterministic summary below
    }
    return fallbackSummary(older);
  }
}

export function estimateMessageTokens(message: Message): number {
  let chars = 0;
  for (const block of message.content) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "thinking") chars += block.thinking.length;
    else if (block.type === "tool_use") chars += block.name.length + JSON.stringify(block.input).length;
    else if (block.type === "tool_result") {
      chars +=
        typeof block.content === "string"
          ? block.content.length
          : block.content.reduce((sum, item) => sum + item.text.length, 0);
    }
  }
  return Math.ceil(chars / 4) + 4;
}

function formatMessageForSummary(message: Message): string {
  const parts: string[] = [`[${message.role}]`];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "thinking") parts.push(block.thinking);
    else if (block.type === "tool_use") parts.push(`called ${block.name}(${JSON.stringify(block.input)})`);
    else if (block.type === "tool_result") {
      const text = typeof block.content === "string" ? block.content : block.content.map((item) => item.text).join("\n");
      parts.push(`tool result: ${text}`);
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
  const toolList = [...tools].sort().join(", ") || "none";
  const fileList = [...files].sort().join(", ") || "none";
  return `${older.length} earlier message(s) compacted without model help. Tools used: ${toolList}. Files touched: ${fileList}.`;
}

function formatNote(note: { topic: string; insight: string; filePatterns: string[]; updatedAt: number }): string {
  const scope = note.filePatterns.length > 0 ? note.filePatterns.join(", ") : "all files";
  return `# ${note.topic}\n${note.insight}\n(scope: ${scope})`;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... truncated after ${limit} characters`;
}
