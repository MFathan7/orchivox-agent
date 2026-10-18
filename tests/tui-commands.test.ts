import { describe, expect, it } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { OrchivoxLogo, WelcomeBanner } from "../src/tui/logo";
import { BUILTIN_SLASH_COMMANDS } from "../src/tui/autocomplete";
import { interpretInput } from "../src/tui/app";

describe("Orchivox TUI & Commands Polish", () => {
  it("creates valid React elements for Orchivox O logo and WelcomeBanner", () => {
    const emblemEl = React.createElement(OrchivoxLogo, { variant: "emblem" });
    expect(React.isValidElement(emblemEl)).toBe(true);

    const compactEl = React.createElement(OrchivoxLogo, { variant: "compact" });
    expect(React.isValidElement(compactEl)).toBe(true);

    const welcomeEl = React.createElement(WelcomeBanner);
    expect(React.isValidElement(welcomeEl)).toBe(true);
  });

  it("renders OrchivoxLogo and WelcomeBanner with Ink without error", () => {
    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });

    const instance1 = render(React.createElement(OrchivoxLogo, { variant: "emblem" }), {
      stdout: stream as unknown as NodeJS.WriteStream,
      patchConsole: false,
    });
    instance1.unmount();

    const instance2 = render(React.createElement(WelcomeBanner), {
      stdout: stream as unknown as NodeJS.WriteStream,
      patchConsole: false,
    });
    instance2.unmount();

    expect(output.length).toBeGreaterThan(0);
  });

  it("interprets all slash commands correctly via interpretInput", () => {
    const testCases = [
      { input: "/help", command: "/help", args: "" },
      { input: "/mode plan", command: "/mode", args: "plan" },
      { input: "/theme catppuccin", command: "/theme", args: "catppuccin" },
      { input: "/reasoning high", command: "/reasoning", args: "high" },
      { input: "/palette", command: "/palette", args: "" },
      { input: "/model", command: "/model", args: "" },
      { input: "/sessions", command: "/sessions", args: "" },
      { input: "/fork", command: "/fork", args: "" },
      { input: "/timeline", command: "/timeline", args: "" },
      { input: "/hub", command: "/hub", args: "" },
      { input: "/undo", command: "/undo", args: "" },
      { input: "/redo", command: "/redo", args: "" },
      { input: "/commit", command: "/commit", args: "" },
      { input: "/compact", command: "/compact", args: "" },
      { input: "/plugins", command: "/plugins", args: "" },
      { input: "/collab", command: "/collab", args: "" },
      { input: "/clear", command: "/clear", args: "" },
      { input: "/exit", command: "/exit", args: "" },
      { input: "/review --staged", command: "/review", args: "--staged" },
      { input: "/fix-tests tests/plan13.test.ts", command: "/fix-tests", args: "tests/plan13.test.ts" },
    ];

    for (const tc of testCases) {
      const action = interpretInput(tc.input);
      expect(action.kind).toBe("command");
      if (action.kind === "command") {
        expect(action.command).toBe(tc.command);
        expect(action.args).toBe(tc.args);
      }
    }
  });

  it("contains all essential commands in BUILTIN_SLASH_COMMANDS list", () => {
    const names = BUILTIN_SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain("/help");
    expect(names).toContain("/mode");
    expect(names).toContain("/theme");
    expect(names).toContain("/reasoning");
    expect(names).toContain("/palette");
    expect(names).toContain("/model");
    expect(names).toContain("/sessions");
    expect(names).toContain("/fork");
    expect(names).toContain("/timeline");
    expect(names).toContain("/hub");
    expect(names).toContain("/undo");
    expect(names).toContain("/redo");
    expect(names).toContain("/commit");
    expect(names).toContain("/compact");
    expect(names).toContain("/plugins");
    expect(names).toContain("/collab");
    expect(names).toContain("/clear");
    expect(names).toContain("/exit");
  });

  it("simulates backspace logic with ASCII 127 (\\x7f) and \\b deletion cleanly", () => {
    function simulateKeyInput(currentText: string, inputChar: string, cursorPos: number): { text: string; cursor: number } {
      const isBackspace = inputChar === "\x7f" || inputChar === "\b";
      if (isBackspace) {
        if (cursorPos > 0) {
          const before = currentText.slice(0, cursorPos - 1);
          const after = currentText.slice(cursorPos);
          return { text: `${before}${after}`, cursor: cursorPos - 1 };
        }
        return { text: currentText, cursor: cursorPos };
      }

      if (inputChar.length > 0 && inputChar >= " " && inputChar !== "\x7f") {
        const before = currentText.slice(0, cursorPos);
        const after = currentText.slice(cursorPos);
        return { text: `${before}${inputChar}${after}`, cursor: cursorPos + inputChar.length };
      }

      return { text: currentText, cursor: cursorPos };
    }

    let state = { text: "hello", cursor: 5 };
    // Send Linux terminal backspace (\x7f)
    state = simulateKeyInput(state.text, "\x7f", state.cursor);
    expect(state.text).toBe("hell");
    expect(state.cursor).toBe(4);

    // Send ASCII \b backspace
    state = simulateKeyInput(state.text, "\b", state.cursor);
    expect(state.text).toBe("hel");
    expect(state.cursor).toBe(3);

    // Type regular char 'p'
    state = simulateKeyInput(state.text, "p", state.cursor);
    expect(state.text).toBe("help");
    expect(state.cursor).toBe(4);

    // Ensure raw \x7f is never inserted as printable text
    state = simulateKeyInput(state.text, "\x7f", state.cursor);
    expect(state.text).toBe("hel");
    expect(state.text).not.toContain("\x7f");
  });
});
