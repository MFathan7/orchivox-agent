import { describe, expect, it } from "bun:test";
import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";

import { deleteNextWord, deletePreviousWord, PromptComposer } from "../src/tui/composer";
import { AutocompletePopup, BUILTIN_SLASH_COMMANDS } from "../src/tui/autocomplete";
import { ScrollableChatViewport } from "../src/tui/viewport";
import { WelcomeBanner, OrchivoxLogo } from "../src/tui/logo";
import { getTheme } from "../src/tui/theme";

describe("Composer Shortcuts & Word Deletion", () => {
  it("deletes previous word accurately with deletePreviousWord", () => {
    // Basic word deletion
    const res1 = deletePreviousWord("hello world", 11);
    expect(res1.nextText).toBe("hello ");
    expect(res1.nextCursor).toBe(6);

    // Word deletion with trailing spaces
    const res2 = deletePreviousWord("hello world   ", 14);
    expect(res2.nextText).toBe("hello ");
    expect(res2.nextCursor).toBe(6);

    // Punctuation deletion
    const res3 = deletePreviousWord("const x = foo();", 16);
    expect(res3.nextText).toBe("const x = foo");
    expect(res3.nextCursor).toBe(13);

    // Deleting single word
    const res4 = deletePreviousWord("orchivox", 8);
    expect(res4.nextText).toBe("");
    expect(res4.nextCursor).toBe(0);

    // Cursor at position 0
    const res5 = deletePreviousWord("hello", 0);
    expect(res5.nextText).toBe("hello");
    expect(res5.nextCursor).toBe(0);
  });

  it("deletes next word accurately with deleteNextWord (forward word delete)", () => {
    // Forward delete from start
    const res1 = deleteNextWord("hello world", 0);
    expect(res1.nextText).toBe(" world");
    expect(res1.nextCursor).toBe(0);

    // Forward delete with leading spaces
    const res2 = deleteNextWord("hello   world", 5);
    expect(res2.nextText).toBe("hello");
    expect(res2.nextCursor).toBe(5);

    // Forward delete punctuation
    const res3 = deleteNextWord("foo();", 3);
    expect(res3.nextText).toBe("foo");
    expect(res3.nextCursor).toBe(3);

    // Cursor at end of text
    const res4 = deleteNextWord("orchivox", 8);
    expect(res4.nextText).toBe("orchivox");
    expect(res4.nextCursor).toBe(8);
  });

  it("BUILTIN_SLASH_COMMANDS has concise argument hints without square brackets", () => {
    const modeCmd = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "/mode");
    expect(modeCmd?.args).toBe("<plan|build|ultrawork>");

    const themeCmd = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "/theme");
    expect(themeCmd?.args).toBe("<name>");

    const reasoningCmd = BUILTIN_SLASH_COMMANDS.find((c) => c.name === "/reasoning");
    expect(reasoningCmd?.args).toBe("<off|low|med|high|max>");

    // Ensure no commands have square brackets in their argument templates
    for (const cmd of BUILTIN_SLASH_COMMANDS) {
      if (cmd.args) {
        expect(cmd.args).not.toContain("[");
        expect(cmd.args).not.toContain("]");
      }
    }
  });

  it("renders AutocompletePopup with fixed column layout cleanly", () => {
    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });

    const items = BUILTIN_SLASH_COMMANDS.slice(0, 5).map((cmd) => ({
      id: `cmd:${cmd.name}`,
      trigger: "command" as const,
      label: cmd.name,
      insertText: `${cmd.name} `,
      detail: cmd.args,
      description: cmd.description,
      kind: "command",
    }));

    const instance = render(
      React.createElement(AutocompletePopup, {
        items,
        selectedIndex: 0,
        trigger: "command",
        theme: getTheme("tokyonight"),
        maxVisible: 5,
      }),
      {
        stdout: stream as unknown as NodeJS.WriteStream,
        patchConsole: false,
      },
    );

    expect(output).toContain("SLASH COMMANDS");
    expect(output).toContain("/help");
    expect(output).toContain("/mode");
    expect(output).toContain("Navigate: Up/Down");
    // Redundant (command) badges must be omitted
    expect(output).not.toContain("(command)");

    instance.unmount();
  });

  it("renders WelcomeBanner on empty session or system-only entries, and hides it when user/assistant chats exist", () => {
    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });

    // 1. Empty entries should display WelcomeBanner
    const instance1 = render(
      React.createElement(ScrollableChatViewport, {
        entries: [],
        width: 80,
        height: 20,
        theme: getTheme("tokyonight"),
        repoPath: "/home/developer/app",
        branch: "main",
      }),
      {
        stdout: stream as unknown as NodeJS.WriteStream,
        patchConsole: false,
      },
    );
    expect(output).toContain("ORCHIVOX");
    expect(output).toContain("AGENT");
    expect(output).toContain("/home/developer/app");
    instance1.unmount();

    // 2. Entries with only system notices should still show WelcomeBanner
    output = "";
    const instance2 = render(
      React.createElement(ScrollableChatViewport, {
        entries: [{ id: "sys-1", role: "system", text: "model reasoning set to: high" }],
        width: 80,
        height: 20,
        theme: getTheme("tokyonight"),
        repoPath: "/home/developer/app",
        branch: "main",
      }),
      {
        stdout: stream as unknown as NodeJS.WriteStream,
        patchConsole: false,
      },
    );
    expect(output).toContain("ORCHIVOX");
    expect(output).toContain("AGENT");
    instance2.unmount();

    // 3. Entries with user chat should hide WelcomeBanner and render the user rail
    output = "";
    const instance3 = render(
      React.createElement(ScrollableChatViewport, {
        entries: [{ id: "user-1", role: "user", text: "hello Orchivox" }],
        width: 80,
        height: 20,
        theme: getTheme("tokyonight"),
        repoPath: "/home/developer/app",
        branch: "main",
      }),
      {
        stdout: stream as unknown as NodeJS.WriteStream,
        patchConsole: false,
      },
    );
    expect(output).toContain("▌");
    expect(output).toContain("hello Orchivox");
    // Welcome Banner title is hidden during active conversation
    expect(output).not.toContain("Type a prompt to begin");
    instance3.unmount();
  });

  it("renders official Orchivox ASCII emblem from Orchivox logos ASCII.md cleanly", () => {
    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });

    const instance = render(React.createElement(OrchivoxLogo, { variant: "emblem" }), {
      stdout: stream as unknown as NodeJS.WriteStream,
      patchConsole: false,
    });

    // Check key distinct emblem patterns from Orchivox logos ASCII.md
    expect(output).toContain("▄▄███▄▄  ╱●");
    expect(output).toContain("▄██▀   ▀█╱´█▄");
    expect(output).toContain("███  ● ╱´ ███");
    expect(output).toContain("▀██▄ ╱´▄███▀");
    expect(output).toContain("●╱▀▀███▀▀");

    instance.unmount();
  });
});
