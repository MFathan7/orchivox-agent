import { describe, expect, it } from "bun:test";

import { cleanReasoningAnswer, stripThinkTags } from "../src/agent/orchestrator";

describe("assistant text cleanup", () => {
  it("strips leaked think tags", () => {
    expect(stripThinkTags("</think>Hello")).toBe("Hello");
    expect(stripThinkTags("Hello</think>")).toBe("Hello");
    expect(stripThinkTags("Hello")).toBe("Hello");
  });

  it("removes internal narration from reasoning fallbacks", () => {
    expect(cleanReasoningAnswer("Let me present this. The result is 3.")).toBe(
      "The result is 3.",
    );
    expect(cleanReasoningAnswer("I need to check. The files are modified.")).toBe(
      "The files are modified.",
    );
  });
});
