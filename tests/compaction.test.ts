import { describe, expect, it } from "bun:test";

import { COMPACT_LABEL, compactMessages, extractSummary } from "../src/agent/compaction";
import { MemoryDatabase } from "../src/memory/sqlite";
import type { LLMProvider } from "../src/provider/router";
import type { ChatRequest, Message, StreamEvent } from "../src/types/schema";

function fakeProvider(summary: string, capture?: (request: ChatRequest) => void): LLMProvider {
  return {
    async *streamChat(request: ChatRequest): AsyncGenerator<StreamEvent, void, unknown> {
      capture?.(request);
      yield { type: "token", text: summary };
      yield { type: "done", finish_reason: "stop" };
    },
    async listModels(): Promise<string[]> {
      return [];
    },
  };
}

function textMessage(id: string, role: Message["role"], text: string): Message {
  return { id, role, content: [{ type: "text", text }] };
}

function messageText(message: Message | undefined): string {
  if (!message) return "";
  return message.content
    .filter((block): block is Extract<Message["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

const conversation: Message[] = [
  textMessage("u1", "user", "first request"),
  textMessage("a1", "assistant", "first answer"),
  textMessage("u2", "user", "second request"),
  textMessage("a2", "assistant", "second answer"),
];

describe("compaction", () => {
  it("force compacts a short history and keeps the recent tail", async () => {
    const result = await compactMessages(conversation, {
      provider: fakeProvider("## Objective\nContinue the work."),
      force: true,
      keepTokens: 10,
    });

    expect(result.didCompact).toBe(true);
    expect(result.summary).toContain("Objective");
    expect(result.removedMessages).toBe(3);
    expect(result.tailStartMessageId).toBe("a2");
    expect(result.messages[0]?.role).toBe("system");
    expect(messageText(result.messages[0])).toContain(COMPACT_LABEL);
    expect(result.messages.at(-1)?.id).toBe("a2");
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  });

  it("respects the context buffer for automatic compaction", async () => {
    const small = [textMessage("u1", "user", "x".repeat(400))];
    const skipped = await compactMessages(small, {
      provider: fakeProvider("summary"),
      contextWindow: 1000,
      bufferRatio: 0.1,
      keepTokens: 100,
    });
    expect(skipped.didCompact).toBe(false);

    const large = [
      textMessage("u1", "user", "x".repeat(6000)),
      textMessage("a1", "assistant", "answer"),
    ];
    const compacted = await compactMessages(large, {
      provider: fakeProvider("## Objective\nContinue."),
      contextWindow: 1000,
      bufferRatio: 0.1,
      keepTokens: 10,
    });
    expect(compacted.didCompact).toBe(true);
  });

  it("merges the previous summary into the new prompt", async () => {
    let captured: ChatRequest | undefined;
    await compactMessages(conversation, {
      provider: fakeProvider("## Objective\nUpdated.", (request) => {
        captured = request;
      }),
      force: true,
      keepTokens: 10,
      previousSummary: "OLD SUMMARY",
    });

    expect(captured).toBeDefined();
    expect(messageText(captured?.messages[0])).toContain("OLD SUMMARY");
  });

  it("persists the compacted context and keeps the full history", () => {
    const database = new MemoryDatabase(":memory:");
    try {
      const session = database.createSession({ title: "test", mode: "build" });
      for (const message of conversation) database.saveMessage(session.id, message);

      database.saveCompaction(session.id, {
        summary: "SUMMARY",
        tail_start_message_id: "u2",
        before_tokens: 100,
        after_tokens: 20,
        created_at: Date.now(),
      });

      const active = database.loadMessages(session.id);
      expect(active).toHaveLength(3);
      expect(active[0]?.role).toBe("system");
      expect(messageText(active[0])).toContain(COMPACT_LABEL);
      expect(active[1]?.id).toBe("u2");
      expect(extractSummary(active)).toBe("SUMMARY");

      const full = database.loadFullMessages(session.id);
      expect(full).toHaveLength(4);
    } finally {
      database.close();
    }
  });
});
