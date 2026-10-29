import { z } from "zod";

import { estimateTokenCost } from "../agent/token-estimate";
import type { Message } from "../types/schema";
import type { AgentTool, ToolRegistry } from "../tools/registry";
import type { MemoryDatabase } from "./sqlite";

export const COMPACT_LABEL = "[COMPACTED SESSION SUMMARY]";

export class HindsightMemory {
  private readonly database: MemoryDatabase;

  constructor(database: MemoryDatabase) {
    this.database = database;
  }

  registerTools(registry: ToolRegistry): void {
    registry.register(this.rememberInsightTool());
    registry.register(this.recallInsightsTool());
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
}

export function estimateMessageTokens(message: Message): number {
  let tokens = 0;
  let imageTokens = 0;
  for (const block of message.content) {
    if (block.type === "text") tokens += estimateTokenCost(block.text);
    else if (block.type === "thinking") tokens += estimateTokenCost(block.thinking);
    else if (block.type === "tool_use") {
      tokens += estimateTokenCost(block.name + JSON.stringify(block.input));
    } else if (block.type === "tool_result") {
      tokens +=
        typeof block.content === "string"
          ? estimateTokenCost(block.content)
          : block.content.reduce((sum, item) => sum + estimateTokenCost(item.text), 0);
    } else if (block.type === "image") {
      imageTokens += Math.max(1000, Math.ceil((block.source.data.length * 3) / 4096));
    }
  }
  return tokens + imageTokens + 4;
}

function formatNote(note: { topic: string; insight: string; filePatterns: string[]; updatedAt: number }): string {
  const scope = note.filePatterns.length > 0 ? note.filePatterns.join(", ") : "all files";
  return `# ${note.topic}\n${note.insight}\n(scope: ${scope})`;
}
