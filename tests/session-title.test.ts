import { describe, expect, it } from "bun:test";

import { generateSessionTitle, normalizeTitle } from "../src/agent/session-title";
import type { LLMProvider } from "../src/provider/router";
import type { ChatRequest, Message, StreamEvent } from "../src/types/schema";

function fakeProvider(chunks: string[], error?: string): LLMProvider {
  return {
    async *streamChat(_request: ChatRequest): AsyncGenerator<StreamEvent, void, unknown> {
      for (const chunk of chunks) yield { type: "token", text: chunk };
      if (error) {
        yield { type: "error", code: "test_error", message: error, recoverable: false };
        yield { type: "done", finish_reason: "error" };
        return;
      }
      yield { type: "done", finish_reason: "stop" };
    },
    async listModels(): Promise<string[]> {
      return [];
    },
  };
}

const messages: Message[] = [
  {
    id: "u1",
    role: "user",
    content: [{ type: "text", text: "Fix the login callback so the state check cannot be bypassed." }],
  },
  {
    id: "a1",
    role: "assistant",
    content: [{ type: "text", text: "I will harden the callback and add a regression test." }],
  },
];

describe("session title generation", () => {
  it("normalizes quotes, markdown, and trailing punctuation", () => {
    expect(normalizeTitle('"Fix the auth flow."')).toBe("Fix the auth flow");
    expect(normalizeTitle("**Harden login callback**")).toBe("Harden login callback");
    expect(normalizeTitle("First line\nsecond line")).toBe("First line");
    expect(normalizeTitle("   ")).toBeUndefined();
  });

  it("truncates a long title to the limit", () => {
    const title = normalizeTitle("a".repeat(80), 20);
    expect(title).toBe(`${"a".repeat(17)}...`);
  });

  it("returns a generated title from the provider", async () => {
    const title = await generateSessionTitle({ messages, provider: fakeProvider(['"Fix auth callback."']) });
    expect(title).toBe("Fix auth callback");
  });

  it("returns undefined when the provider fails or there is no user message", async () => {
    const failed = await generateSessionTitle({ messages, provider: fakeProvider([], "boom") });
    expect(failed).toBeUndefined();

    const empty = await generateSessionTitle({
      messages: [{ id: "s1", role: "system", content: [{ type: "text", text: "hello" }] }],
      provider: fakeProvider(["Title"]),
    });
    expect(empty).toBeUndefined();
  });
});
