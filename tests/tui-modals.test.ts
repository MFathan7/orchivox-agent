import { describe, expect, it } from "bun:test";
import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";

import { ToolApprovalModal } from "../src/tui/approval-modal";
import { QuestionModal } from "../src/tui/question-modal";

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

describe("interactive modals", () => {
  it("renders question options with arrows, space, and a custom answer", () => {
    const captured = capture(
      React.createElement(QuestionModal, {
        request: {
          id: "q1",
          question: "Pick a framework",
          header: "Framework",
          options: [{ label: "Next.js" }, { label: "Vite" }],
          multiple: true,
          allow_custom: true,
        },
        onAnswer: () => undefined,
      }),
    );

    const output = captured.read();
    expect(output).toContain("Framework");
    expect(output).toContain("Pick a framework");
    expect(output).toContain("Next.js");
    expect(output).toContain("Vite");
    expect(output).toContain("Type a custom answer");
    expect(output).toContain("Space toggle");
    expect(output).not.toContain("Press a letter");
    captured.unmount();
  });

  it("renders approval actions vertically without letter hotkeys", () => {
    const captured = capture(
      React.createElement(ToolApprovalModal, {
        request: {
          id: "a1",
          toolCallId: "call-1",
          toolName: "bash",
          args: {},
          mode: "build",
          readOnly: false,
          reason: "Command needs approval.",
        },
        onDecision: () => undefined,
      }),
    );

    const output = captured.read();
    expect(output).toContain("Approve once");
    expect(output).toContain("Always allow");
    expect(output).toContain("Deny");
    expect(output).toContain("Deny with feedback");
    expect(output).toContain("Up/Down move");
    expect(output).not.toContain("y Approve");
    expect(output).not.toContain("a Always");
    captured.unmount();
  });
});
