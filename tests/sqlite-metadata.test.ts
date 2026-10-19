import { describe, expect, it } from "bun:test";

import { MemoryDatabase } from "../src/memory/sqlite";

describe("message metadata", () => {
  it("persists assistant mode, model, and speed across reloads", () => {
    const database = new MemoryDatabase(":memory:");
    const session = database.createSession({ title: "metadata", mode: "build" });
    database.saveMessage(session.id, {
      id: "assistant-1",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      metadata: {
        mode: "build",
        model: "qwen3.5:9b",
        tokens_per_second: 42.5,
        completion_tokens: 120,
      },
      created_at: 100,
    });

    const loaded = database.loadFullMessages(session.id);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].metadata).toEqual({
      mode: "build",
      model: "qwen3.5:9b",
      tokens_per_second: 42.5,
      completion_tokens: 120,
    });
    database.close();
  });
});
