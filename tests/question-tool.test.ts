import { describe, expect, it } from "bun:test";

import { createQuestionTool } from "../src/tools/question";

describe("question tool", () => {
  it("returns selected options and a custom answer", async () => {
    let receivedId = "";
    const tool = createQuestionTool(async (request) => {
      receivedId = request.id;
      expect(request.question).toBe("Pick a framework");
      expect(request.multiple).toBe(true);
      return { selected: ["Next.js", "Vite"], custom: "Astro" };
    });

    const result = await tool.execute({
      question: "Pick a framework",
      header: "Framework",
      options: [{ label: "Next.js" }, { label: "Vite" }],
      multiple: true,
      allow_custom: true,
    });

    expect(receivedId.startsWith("question-")).toBe(true);
    expect(result).toContain("Selected: Next.js, Vite");
    expect(result).toContain("Custom answer: Astro");
  });

  it("handles a cancelled question", async () => {
    const tool = createQuestionTool(async () => ({
      selected: [],
      cancelled: true,
    }));

    const result = await tool.execute({
      question: "Continue?",
      options: [{ label: "Yes" }, { label: "No" }],
      multiple: false,
      allow_custom: false,
    });

    expect(result).toBe("User cancelled the question.");
  });
});
