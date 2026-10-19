import { describe, expect, it } from "bun:test";

import { COMPACT_LABEL, compactMessages, extractSummary } from "../src/agent/compaction";
import { estimateMessageTokens } from "../src/memory/hindsight";
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

function exchange(index: number): Message[] {
  return [
    textMessage(`u${index}`, "user", `request number ${index} about the parser`),
    textMessage(`a${index}`, "assistant", `answer number ${index} with the fix`),
  ];
}

const conversation: Message[] = [...exchange(1), ...exchange(2)];

describe("compaction", () => {
  it("force compacts a short history and keeps the latest exchange", async () => {
    const result = await compactMessages(conversation, {
      provider: fakeProvider("## Objective\nContinue the work."),
      force: true,
      keepTokens: 10,
    });

    expect(result.didCompact).toBe(true);
    expect(result.summary).toContain("Objective");
    expect(result.removedMessages).toBe(2);
    expect(result.tailStartMessageId).toBe("u2");
    expect(result.messages[0]?.role).toBe("system");
    expect(messageText(result.messages[0])).toContain(COMPACT_LABEL);
    expect(result.messages.at(-1)?.id).toBe("a2");
  });

  it("force compacts when the whole history fits the keep window", async () => {
    const short = [...exchange(1), ...exchange(2), ...exchange(3)];
    const total = short.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    expect(total).toBeLessThan(15_000);

    const result = await compactMessages(short, {
      provider: fakeProvider("## Objective\nContinue."),
      force: true,
      keepTokens: 15_000,
    });

    expect(result.didCompact).toBe(true);
    expect(result.removedMessages).toBe(4);
    expect(result.tailStartMessageId).toBe("u3");
    expect(result.messages.at(-1)?.id).toBe("a3");
  });

  it("force summarizes a single exchange and keeps no tail", async () => {
    const result = await compactMessages(exchange(1), {
      provider: fakeProvider("## Objective\nOnly exchange."),
      force: true,
      keepTokens: 15_000,
    });

    expect(result.didCompact).toBe(true);
    expect(result.removedMessages).toBe(2);
    expect(result.tailStartMessageId).toBeUndefined();
    expect(result.messages).toHaveLength(1);
    expect(messageText(result.messages[0])).toContain(COMPACT_LABEL);
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

  it("reduces tokens on a longer history", async () => {
    const long = [
      textMessage("u1", "user", "x".repeat(4000)),
      textMessage("a1", "assistant", "y".repeat(4000)),
      ...exchange(2),
    ];

    const result = await compactMessages(long, {
      provider: fakeProvider("Short summary."),
      force: true,
      keepTokens: 100,
    });

    expect(result.didCompact).toBe(true);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    expect(result.tailStartMessageId).toBe("u2");
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

  it("resumes a keep-nothing compaction as the summary only", () => {
    const database = new MemoryDatabase(":memory:");
    try {
      const session = database.createSession({ title: "test", mode: "build" });
      for (const message of conversation) database.saveMessage(session.id, message);

      database.saveCompaction(session.id, {
        summary: "SUMMARY",
        before_tokens: 100,
        after_tokens: 20,
        created_at: Date.now(),
      });

      const active = database.loadMessages(session.id);
      expect(active).toHaveLength(1);
      expect(active[0]?.role).toBe("system");
      expect(extractSummary(active)).toBe("SUMMARY");
      expect(database.loadFullMessages(session.id)).toHaveLength(4);
    } finally {
      database.close();
    }
  });
});
