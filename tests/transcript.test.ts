import { describe, expect, it } from "bun:test";
import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";

import type { SessionCompaction } from "../src/memory/sqlite";
import { getTheme } from "../src/tui/theme";
import {
  buildTranscriptEntries,
  compactionEntryView,
  messageEntryText,
} from "../src/tui/transcript";
import { ScrollableChatViewport } from "../src/tui/viewport";
import type { Message } from "../src/types/schema";

function textMessage(id: string, role: Message["role"], text: string): Message {
  return { id, role, content: [{ type: "text", text }] };
}

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

const messages: Message[] = [
  textMessage("u1", "user", "first request"),
  textMessage("a1", "assistant", "first answer"),
  textMessage("u2", "user", "second request"),
  textMessage("a2", "assistant", "second answer"),
  textMessage("u3", "user", "third request"),
  textMessage("a3", "assistant", "third answer"),
];

const compaction: SessionCompaction = {
  summary: "## Objective\nContinue the parser work.",
  tail_start_message_id: "u3",
  before_tokens: 4000,
  after_tokens: 2400,
  created_at: 123,
  removed_messages: 4,
  auto: true,
};

describe("transcript compaction entry", () => {
  it("reads text blocks from a message", () => {
    expect(messageEntryText(messages[0])).toBe("first request");
  });

  it("inserts the compaction entry before the retained tail", () => {
    const entries = buildTranscriptEntries(messages, compaction);
    expect(entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "compaction",
      "user",
      "assistant",
    ]);
    expect(entries[4]?.text).toContain("Objective");
    expect(entries[4]?.compaction?.beforeTokens).toBe(4000);
    expect(entries[4]?.compaction?.removedMessages).toBe(4);
  });

  it("prepends the compaction entry when there is no tail", () => {
    const entries = buildTranscriptEntries(messages, {
      ...compaction,
      tail_start_message_id: undefined,
    });
    expect(entries[0]?.role).toBe("compaction");
  });

  it("keeps the plain transcript when there is no compaction", () => {
    const entries = buildTranscriptEntries(messages);
    expect(entries).toHaveLength(messages.length);
    expect(entries.some((entry) => entry.role === "compaction")).toBe(false);
  });

  it("renders the summary and the token footer", () => {
    const captured = capture(
      React.createElement(ScrollableChatViewport, {
        entries: [compactionEntryView(compaction)],
        width: 100,
        height: 40,
        theme: getTheme("tokyonight"),
      }),
    );

    const output = captured.read();
    expect(output).toContain("auto compacted");
    expect(output).toContain("Objective");
    expect(output).toContain("4k -> 2.4k tokens");
    captured.unmount();
  });

  it("draws the user rail on every wrapped line", () => {
    const captured = capture(
      React.createElement(ScrollableChatViewport, {
        entries: [
          {
            id: "u1",
            role: "user",
            text: "one two three four five six seven eight nine ten",
          },
        ],
        width: 24,
        height: 20,
        theme: getTheme("tokyonight"),
      }),
    );

    const rails = captured
      .read()
      .split("\n")
      .filter((line) => line.includes("▌")).length;
    expect(rails).toBeGreaterThan(1);
    captured.unmount();
  });
});
