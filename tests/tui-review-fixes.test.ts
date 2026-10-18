import { describe, expect, it } from "bun:test";
import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";

import type { SkillDocument } from "../src/agent/skills";
import { ChoiceModal } from "../src/tui/choice-modal";
import { truncateText } from "../src/tui/format";
import { MarkdownView, normalizeHtml, parseMarkdown } from "../src/tui/markdown";
import { SkillsModal } from "../src/tui/skills-modal";
import { getTheme } from "../src/tui/theme";
import { ScrollableChatViewport } from "../src/tui/viewport";

function capture(element: React.ReactElement): { read: () => string; unmount: () => void } {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });

  const instance = render(element, {
    stdout: stream as unknown as NodeJS.WriteStream,
    patchConsole: false,
  });

  return {
    read: () => output,
    unmount: () => instance.unmount(),
  };
}

describe("TUI review fixes", () => {
  it("truncates long text with an ellipsis", () => {
    expect(truncateText("short", 10)).toBe("short");
    expect(truncateText("abcdefghij", 7)).toBe("abcd...");
    expect(truncateText("abc", 2)).toBe("ab");
    expect(truncateText("abc", 0)).toBe("");
  });

  it("renders reasoning and tool calls before the final answer", () => {
    const captured = capture(
      React.createElement(ScrollableChatViewport, {
        entries: [
          {
            id: "assistant-1",
            role: "assistant",
            text: "FINAL_ANSWER",
            thinking: "REASONING_BLOCK",
            toolCalls: [{ name: "read_file", argumentsSummary: "src/index.ts", status: "ok" as const }],
          },
        ],
        width: 100,
        height: 40,
        theme: getTheme("tokyonight"),
        initiallyCollapsed: false,
      }),
    );

    const output = captured.read();
    expect(output).toContain("REASONING_BLOCK");
    expect(output).toContain("FINAL_ANSWER");
    expect(output.indexOf("REASONING_BLOCK")).toBeLessThan(output.indexOf("FINAL_ANSWER"));
    captured.unmount();
  });

  it("renders skills as one-line entries without the body preview", () => {
    const skills: SkillDocument[] = [
      {
        name: "antislop",
        description: `Stops generic AI slop in UI and copy. ${"x".repeat(120)}`,
        path: "/skills/antislop/SKILL.md",
        scope: "global",
        body: "BODY_PREVIEW_SHOULD_NOT_RENDER\nsecond line",
      },
    ];

    const captured = capture(
      React.createElement(SkillsModal, {
        skills,
        width: 100,
        theme: getTheme("tokyonight"),
        onClose: () => undefined,
      }),
    );

    const output = captured.read();
    expect(output).toContain("antislop");
    expect(output).toContain("global");
    expect(output).toContain("...");
    expect(output).not.toContain("BODY_PREVIEW_SHOULD_NOT_RENDER");
    captured.unmount();
  });

  it("renders every choice with its purpose and the current marker", () => {
    const captured = capture(
      React.createElement(ChoiceModal, {
        title: "Mode",
        options: [
          {
            id: "plan",
            label: "Plan",
            description: "Read-only. Inspect and plan, no file changes.",
            current: true,
          },
          {
            id: "build",
            label: "Build",
            description: "Normal work. File changes ask for approval.",
          },
        ],
        theme: getTheme("tokyonight"),
        onSelect: () => undefined,
        onCancel: () => undefined,
      }),
    );

    const output = captured.read();
    expect(output).toContain("Plan");
    expect(output).toContain("Read-only");
    expect(output).toContain("Build");
    expect(output).toContain("approval");
    expect(output).toContain("current");
    captured.unmount();
  });

  it("sanitizes HTML into readable text and entities", () => {
    const source = "Hello<br>world <strong>bold</strong> &amp; <em>soft</em><br/>";
    const normalized = normalizeHtml(source);
    expect(normalized).toContain("Hello\nworld");
    expect(normalized).toContain("**bold**");
    expect(normalized).toContain("&");
    expect(normalized).toContain("*soft*");
    expect(normalized).not.toContain("<strong>");
    expect(normalizeHtml("if (a < b && c > d)").trim()).toBe("if (a < b && c > d)");
    expect(normalizeHtml("```\n<b>keep</b>\n```")).toContain("<b>keep</b>");
  });

  it("parses tables, task lists, rules, nested bullets, and line breaks", () => {
    const blocks = parseMarkdown(
      [
        "# Title",
        "",
        "| Name | Value |",
        "| --- | :---: |",
        "| a | 1 |",
        "",
        "---",
        "",
        "- [x] done",
        "- [ ] todo",
        "",
        "- top",
        "  - nested",
        "",
        "line one",
        "line two",
      ].join("\n"),
    );

    expect(blocks.some((block) => block.kind === "hr")).toBe(true);
    expect(blocks.some((block) => block.kind === "table")).toBe(true);
    const task = blocks.find((block) => block.kind === "task");
    expect(task && task.kind === "task" ? task.items[0]?.checked : undefined).toBe(true);
    const bullet = blocks.find((block) => block.kind === "bullet");
    expect(bullet && bullet.kind === "bullet" ? bullet.items[1]?.indent : undefined).toBe(1);
    const paragraph = blocks.find((block) => block.kind === "paragraph");
    expect(paragraph && paragraph.kind === "paragraph" ? paragraph.lines.length : 0).toBe(2);
  });

  it("renders markdown inline styles, links, and tables", () => {
    const captured = capture(
      React.createElement(MarkdownView, {
        content: [
          "**bold** and *italic* and ~~gone~~",
          "",
          "[docs](https://example.com)",
          "",
          "| Key | Value |",
          "| --- | --- |",
          "| a | 1 |",
        ].join("\n"),
        theme: getTheme("tokyonight"),
      }),
    );

    const output = captured.read();
    expect(output).toContain("bold");
    expect(output).toContain("italic");
    expect(output).toContain("gone");
    expect(output).toContain("docs");
    expect(output).toContain("https://example.com");
    expect(output).toContain("Key");
    expect(output).toContain("Value");
    captured.unmount();
  });
});
