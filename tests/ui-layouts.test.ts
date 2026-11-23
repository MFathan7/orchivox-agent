import { expect, test } from "bun:test";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import React from "react";

import { parseConfigText } from "../src/config/loader";
import { saveTheme, saveUiLayout } from "../src/config/writer";
import { ProviderRouter } from "../src/provider/router";
import { resolveProjectState } from "../src/runtime-paths";
import { OrchivoxApp, type ChatEntryView, type OrchivoxAppProps } from "../src/tui/app";
import { FrameClock } from "../src/tui/frame-clock";
import { rowContent } from "../src/tui/rows";
import { displayWidth } from "../src/tui/text-wrap";
import { DEFAULT_THEME, THEME_NAMES, getTheme, resolveThemeSelection, type ThemeSelection } from "../src/tui/theme";
import { buildTranscriptRows } from "../src/tui/transcript-lines";
import { UI_LAYOUTS, type UiLayout } from "../src/types/ui-layout";

test("older theme settings keep their palette and gain the default layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchivox-ui-layout-"));
  const path = join(root, "config.yaml");
  try {
    const original = "theme: orbit-dark\nui:\n  animations: false\n";
    expect(parseConfigText(original, path).ui.layout).toBe("orchivox");
    await writeFile(path, original);
    await saveUiLayout(path, "review");
    expect(parseConfigText(await Bun.file(path).text(), path).theme).toBe("orbit-dark");
    await saveTheme(path, "paper");
    const reopened = parseConfigText(await Bun.file(path).text(), path);
    expect(reopened.theme).toBe("paper");
    expect(reopened.ui).toEqual({ animations: false, layout: "review" });
  } finally {
    if (await Bun.file(path).exists()) await unlink(path);
    await rmdir(root);
  }
});

test("theme picker and prompt controls work across terminal sizes and layouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchivox-theme-picker-"));
  const previousStateHome = process.env.ORCHIVOX_STATE_HOME;
  process.env.ORCHIVOX_STATE_HOME = root;
  const { history, dataDir } = resolveProjectState();
  const ready = Promise.withResolvers<void>();
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (enabled: boolean) => { if (enabled) ready.resolve(); },
    ref() {},
    unref() {},
  });
  let screen = "";
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      screen = stripVTControlCharacters(chunk.toString()).trimEnd();
      callback();
    },
  }), { columns: 40, rows: 16 });
  let layout: UiLayout = "orchivox";
  let color: ThemeSelection = "auto";
  const submissions: Array<Parameters<NonNullable<OrchivoxAppProps["onSubmit"]>>> = [];
  const modeChanges: string[] = [];
  let aborts = 0;
  const props: OrchivoxAppProps = {
    router: new ProviderRouter(parseConfigText("{}", join(root, "config.yaml"))),
    entries: [{ id: "message", role: "user", text: "Check the project layout." }],
    currentTheme: DEFAULT_THEME,
    terminalAppearance: "dark",
    animations: false,
    onLayoutChange(next) { layout = next; redraw(); },
    onThemeChange(next) {
      color = next;
      props.currentTheme = resolveThemeSelection(next, "dark");
      redraw();
    },
    onSubmit(...submission) { submissions.push(submission); return true; },
    onModeChange(mode) { modeChanges.push(mode); },
    onAbort() { aborts++; },
  };
  const node = () => React.createElement(OrchivoxApp, { ...props, layout, themeSelection: color });
  const app = render(node(), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
  });
  const redraw = () => app.rerender(node());
  const waitUntil = async (predicate: () => boolean) => {
    const deadline = Date.now() + 1800;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
    if (!predicate()) throw new Error(`Expected terminal state was not reached.\n${screen}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const send = async (input: string, predicate: () => boolean) => {
    stdin.write(input);
    await waitUntil(predicate);
  };
  const contains = (line: string) => () => screen.includes(line);
  const layoutTab = contains("Theme  [Layout]  Colors");
  const colorsTab = contains("Theme  Layout  [Colors]");
  const typeCommand = async (input: string, predicate: () => boolean) => {
    await send(input, contains(input));
    await send("\r", predicate);
  };
  const expectBounds = () => {
    expect(screen.split("\n").length).toBeLessThanOrEqual(stdout.rows);
    expect(screen.split("\n").every((line) => displayWidth(line) <= stdout.columns)).toBe(true);
  };
  const promptFrame = () => screen.split("\n").find((line) => /^ *┌─+┐$/.test(line));

  try {
    await ready.promise;
    await typeCommand("/theme", layoutTab);
    expect(screen).toContain("❯ Orchivox · active");
    expectBounds();
    await send("\x1b[B", contains("❯ Claude Code"));
    expect(layout).toBe("orchivox");
    await send("\r", contains("Claude Code · active"));
    expect(layoutTab()).toBe(true);
    expect<UiLayout>(layout).toBe("reading");

    await send("\t", colorsTab);
    expect(screen).toContain("❯ Auto (Tokyo Night) · active");
    await send("\x1b[<65;1;1M", contains("❯ Orbit Dark"));
    await send("\r", contains("Orbit Dark · active"));
    expect<ThemeSelection>(color).toBe("orbit-dark");
    expect(colorsTab()).toBe(true);
    await send("\x1b[B", contains("Requires a light terminal"));
    await send("\r", contains("Requires a light terminal"));
    await send("\x1b[Z", layoutTab);
    expect<ThemeSelection>(color).toBe("orbit-dark");
    expect(modeChanges).toEqual([]);
    await send("\x1b[B", contains("❯ Codex"));
    await send("\x1b", () => !layoutTab());
    expect<UiLayout>(layout).toBe("reading");

    await send("\x10", contains("Palette"));
    expectBounds();
    await send("theme", contains("❯ Theme · Layout and colors"));
    await send("\r", layoutTab);
    expect(screen).toContain("❯ Claude Code · active");
    await send("\x1b[B", contains("❯ Codex"));
    await send("\r", contains("❯ Codex · active"));
    await send("\x1b", () => !layoutTab());
    expect<UiLayout>(layout).toBe("review");

    stdout.columns = 160;
    stdout.rows = 26;
    stdout.emit("resize");
    await waitUntil(() => screen.split("\n").some((line) => /^ ─{158}$/.test(line.trimEnd())));
    expect(screen).not.toContain("Modified files");
    await send("\x02", contains("Modified files"));
    await typeCommand("/theme monochrome", () => submissions.length === 1);
    expect(submissions[0][1]).toMatchObject({ kind: "command", command: "/theme", args: "monochrome" });

    layout = "compact";
    redraw();
    await waitUntil(contains("> Ask Orchivox"));
    layout = "review";
    redraw();
    await waitUntil(contains("› Ask Orchivox"));
    layout = "reading";
    redraw();
    await waitUntil(contains("❯ Ask Orchivox"));
    const activeRule = " " + "─".repeat(Math.floor((stdout.columns - 2) * 0.72));
    const linesAround = (text: string) => {
      const lines = screen.split("\n").map((line) => line.trimEnd());
      const index = lines.findIndex((line) => line.includes(text));
      return lines.slice(Math.max(0, index - 1), index + 2);
    };
    expect(linesAround("❯ Ask Orchivox")).toEqual([activeRule, "  ❯ Ask Orchivox", activeRule]);
    await send("Check rendering", contains("❯ Check rendering"));
    await send("\n", contains("1 │ Check rendering"));
    await send("Second line", contains("2 │ Second line"));
    expect(linesAround("1 │ Check rendering")[0]).toBe(activeRule);
    expect(linesAround("2 │ Second line").at(-1)).toBe(activeRule);
    await send("\x1b", contains("❯ Ask Orchivox"));

    layout = "orchivox";
    redraw();
    await waitUntil(() => promptFrame()?.startsWith(" ┌") === true);
    const splitWidth = displayWidth(promptFrame()!.trim());
    layout = "reading";
    redraw();
    const splitRule = " " + "─".repeat(splitWidth);
    await waitUntil(() => screen.split("\n").some((line) => line.trimEnd() === splitRule));
    expect(screen).toContain("Modified files");
    await send("\x02", () => !screen.includes("Modified files"));
    expect(screen.split("\n").some((line) => /^ ─{158}$/.test(line.trimEnd()))).toBe(true);
    expect(promptFrame()).toBeUndefined();
    layout = "compact";
    redraw();
    await waitUntil(() => screen.trimEnd().split("\n").at(-1)?.includes("ctx ") === true);

    for (const [columns, rows] of [[80, 24], [40, 16]]) {
      stdout.columns = columns;
      stdout.rows = rows;
      stdout.emit("resize");
      await waitUntil(() => screen.includes("Ask Orchivox") && !screen.includes("Modified files"));
      for (const theme of THEME_NAMES) {
        props.currentTheme = theme;
        for (const value of UI_LAYOUTS) {
          layout = value;
          redraw();
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(screen).toContain("Ask Orchivox");
          expectBounds();
        }
      }
    }

    props.entries = Array.from({ length: 16 }, (_, index) => ({
      id: `previous-${index}`, role: "user", text: `Previous prompt ${index}`,
    }));
    props.busy = true;
    props.liveEntry = {
      id: "active", role: "assistant", live: true, text: "Current **answer**",
      toolCalls: [{ name: "shell", command: "git status", status: "running", argumentsSummary: "" }],
    };
    for (const value of UI_LAYOUTS) {
      layout = value;
      redraw();
      await waitUntil(contains("Run command · Running"));
      expect(screen).toContain("Current answer");
      expectBounds();
      await send("\x1b[5~", contains("AUTO-SCROLL PAUSED"));
      await send("\x1b[F", () => !screen.includes("AUTO-SCROLL PAUSED"));
    }
    props.liveEntry = undefined;
    props.busy = false;
    redraw();
    await waitUntil(() => !screen.includes("Current answer"));

    const pasted = `Check @README.md:2-3\n${"A long pasted line with no shortcut sequences. ".repeat(12).trimEnd()}`;
    for (const value of UI_LAYOUTS) {
      layout = value;
      redraw();
      await send(`\x1b[200~${pasted}\x1b[201~`, contains("[Pasted"));
      expectBounds();
      const expectedCount = submissions.length + 1;
      await send("\r", () => submissions.length === expectedCount);
      expect(submissions.at(-1)?.[0]).toBe(pasted);
      expect(submissions.at(-1)?.[2]).toMatchObject([{ filePath: "README.md", startLine: 2, endLine: 3, kind: "text" }]);
      expect(submissions.at(-1)?.[2]?.[0]).not.toHaveProperty("context");
      await waitUntil(contains("Ask Orchivox"));
    }
    await send("\x1b[Z", () => modeChanges.length === 1);
    props.busy = true;
    redraw();
    await waitUntil(contains("Thinking"));
    await send("\x1b", contains("Press Esc again"));
    await send("\x1b", () => aborts === 1);
  } finally {
    app.unmount();
    app.cleanup();
    if (previousStateHome === undefined) delete process.env.ORCHIVOX_STATE_HOME;
    else process.env.ORCHIVOX_STATE_HOME = previousStateHome;
    if (await Bun.file(history).exists()) await unlink(history);
    await rmdir(dataDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(root);
  }
}, 15000);

test("the same transcript renders distinct tool and diff styles at the same width", () => {
  const entries: ChatEntryView[] = [{
    id: "same-user", role: "user", text: "Change the branch name.",
  }, {
    id: "same-assistant", role: "assistant", text: "## Updated\n\nThe branch name is now main.",
    toolCalls: [
      { name: "shell", command: "git status --short", status: "ok", argumentsSummary: "" },
      { name: "hash_edit", filePath: "config.ts", status: "ok", argumentsSummary: "",
        diff: { oldText: "branch: old", newText: "branch: main" } },
    ],
  }];
  const transcript = (layout: UiLayout) => buildTranscriptRows(entries, {
    layout, width: 72, theme: getTheme(DEFAULT_THEME), collapsed: false,
    expandedGroups: new Set(), thinkingExpanded: false,
  }).map((row) => rowContent(row.node).text.trimEnd()).join("\n");
  const [orchivox, claude, codex, pi] = UI_LAYOUTS.map(transcript);
  expect(orchivox).toContain("┌─ ○ Run command · Done");
  expect(claude).toContain("↳ Edit · Done · config.ts");
  expect(codex).toContain("    1 + branch: main");
  expect(codex).toContain("• ## Updated");
  expect(pi).toContain("• Run command · Done · $ git status --short");
  expect(pi.split("\n").length).toBeLessThan(orchivox.split("\n").length);
  expect(transcript("orchivox")).toBe(orchivox);
});

test("Claude Code, Codex, and Pi show live status through tool updates and cancellation", async () => {
  const previousTerminal = process.env.TERM;
  const previousNoColor = process.env.NO_COLOR;
  process.env.TERM = "xterm-256color";
  delete process.env.NO_COLOR;
  const callbacks = new Set<() => void>();
  const clock = new FrameClock();
  let time = 0;
  clock.snapshot = () => time;
  clock.subscribe = (callback) => {
    callbacks.add(callback);
    return () => { callbacks.delete(callback); };
  };
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  });
  let screen = "";
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      const frame = stripVTControlCharacters(chunk.toString());
      if (frame.includes("Ask Orchivox")) screen = frame;
      callback();
    },
  }), { isTTY: true, columns: 80, rows: 24 });
  const turn: ChatEntryView = { id: "turn", role: "assistant", text: "", live: true, toolCalls: [] };
  const props: OrchivoxAppProps = {
    layout: "reading",
    frameClock: clock,
    entries: [{ id: "request", role: "user", text: "Check the entry point." }],
    busy: true,
    liveEntry: turn,
    onAbort() {
      props.entries = [...props.entries, { ...turn, live: false, toolCalls: [
        { ...turn.toolCalls![0], status: "cancelled" },
      ] }];
      props.busy = false;
      props.liveEntry = undefined;
      props.streamingText = undefined;
      redraw();
    },
  };
  const node = () => React.createElement(OrchivoxApp, { ...props });
  const app = render(node(), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
  });
  const redraw = () => app.rerender(node());
  const rendered = async (text: string) => {
    const deadline = Date.now() + 1000;
    while (!screen.includes(text) && Date.now() < deadline) await Bun.sleep(5);
    expect(screen).toContain(text);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const advance = (milliseconds = 90) => {
    time += milliseconds;
    for (const callback of callbacks) callback();
  };
  const promptRow = () => screen.split("\n").findIndex((row) => row.includes("Ask Orchivox"));

  try {
    await rendered("· Thinking");
    const composerRow = promptRow();
    advance();
    await rendered("◇ Thinking");
    expect(callbacks.size).toBe(1);

    turn.toolCalls = [
      { name: "read_file", id: "read", filePath: "src/index.ts", argumentsSummary: "", status: "running" },
      { name: "grep_search", id: "search", detail: "entry point", argumentsSummary: "", status: "running" },
    ];
    redraw();
    await rendered("◇ Running 2 tools");
    expect(screen).toContain("• Reading file · src/index.ts");
    expect(screen).toContain("• Searching code · entry point");
    expect(callbacks.size).toBe(1);
    advance();
    await rendered("✦ Running 2 tools");

    turn.toolCalls = [
      { ...turn.toolCalls[0], status: "ok" },
      { ...turn.toolCalls[1], progress: { progress: 2, total: 5, message: "Scanning" } },
    ];
    redraw();
    await rendered("2/5 · Scanning");
    expect(screen).toContain("1 running · 1 done");

    turn.toolCalls = [turn.toolCalls[0], { ...turn.toolCalls[1], status: "error", output: "Search failed to open the directory." }];
    turn.text = "The entry point is registered.";
    props.streamingText = turn.text;
    redraw();
    await rendered("✦ Answering");
    expect(screen).toContain("Search failed to open the directory.");
    expect(screen).toContain("The entry point is registered.");
    expect(promptRow()).toBe(composerRow);

    turn.toolCalls = [{ name: "shell", command: "git status", argumentsSummary: "", status: "running" }];
    turn.text = "";
    props.streamingText = undefined;
    const command = turn.toolCalls[0];
    turn.toolCalls = [{ ...command, status: "ok", output: "first row\nsecond row\nthird row\nlast row" }];
    redraw();
    await rendered("2 more rows · Ctrl+O");
    expect(screen).not.toContain("last row");
    stdin.write("\x0f");
    await rendered("last row");
    stdin.write("\x0f");
    await rendered("2 more rows · Ctrl+O");

    turn.toolCalls = [command];
    props.animations = false;
    redraw();
    await rendered("↳ Run command · Running · $ git status");
    expect(callbacks.size).toBe(0);
    props.animations = true;
    redraw();
    await rendered("✦ Running shell · git status");
    expect(callbacks.size).toBe(1);

    stdout.columns = 40;
    stdout.rows = 16;
    stdout.emit("resize");
    await rendered("✦ Running shell · git status");
    expect(screen.split("\n").every((row) => displayWidth(row) <= 40)).toBe(true);
    stdin.write("\x1b");
    await rendered("Press Esc again");
    stdin.write("\x1b");
    await rendered("Run command · Cancelled");
    expect(callbacks.size).toBe(0);

    props.layout = "review";
    props.entries = props.entries.slice(0, 1);
    props.busy = true;
    props.liveEntry = turn;
    turn.startedAt = Date.now() - 2000;
    turn.toolCalls = [];
    redraw();
    await rendered("Working ·");
    expect(screen).toMatch(/Working · \d+s · Esc twice to stop/);
    const codexComposerRow = promptRow();
    expect(callbacks.size).toBe(2);

    const read = {
      name: "read_file", label: "Reading file", argumentsSummary: "", status: "running" as const,
      filePath: String.raw`src\config\providers\local-model-settings.ts`,
      progress: { progress: 2, total: 5 },
    };
    turn.toolCalls = [read];
    redraw();
    await rendered("└ Reading file · 2/5");
    expect(screen).toContain("• Reading file · Running");
    expect(promptRow()).toBe(codexComposerRow);
    expect(callbacks.size).toBe(3);
    advance(400);
    await rendered("· Reading file · Running");
    expect(screen.split("\n").every((row) => displayWidth(row) <= 40)).toBe(true);

    stdout.columns = 80;
    stdout.rows = 24;
    stdout.emit("resize");
    await rendered(read.filePath);
    const codexWideComposerRow = promptRow();
    turn.toolCalls = [read, { ...command, label: "Running command" }];
    redraw();
    await rendered("└ Running 2 tools");
    await rendered("· Running command · $ git status");
    advance(400);
    await rendered("• Running command · $ git status");
    expect(screen).toContain("• Reading file · 2/5");
    expect(promptRow()).toBe(codexWideComposerRow);
    expect(callbacks.size).toBe(4);
    turn.toolCalls = [{ ...read, status: "ok" }, { ...command, status: "error", output: "The command failed." }];
    turn.text = "The workspace was checked.";
    props.streamingText = turn.text;
    redraw();
    await rendered("Answering ·");
    await rendered("• The workspace was checked.");
    advance(400);
    await rendered("· The workspace was checked.");
    expect(screen).toContain("• Reading file · Done");
    expect(screen).toContain("• Run command · Error");
    expect(screen).not.toContain("└ Running 2 tools");
    expect(screen).toContain("The command failed.");
    expect(promptRow()).toBe(codexWideComposerRow);
    expect(callbacks.size).toBe(3);

    props.entries = [...props.entries, { ...turn, live: false }];
    props.liveEntry = undefined;
    props.streamingText = undefined;
    props.busy = false;
    redraw();
    await rendered("• The workspace was checked.");
    expect(callbacks.size).toBe(0);

    props.entries = props.entries.slice(0, 1);
    props.liveEntry = turn;
    props.busy = true;
    props.animations = false;
    turn.toolCalls = [{ ...command, label: "Running command" }];
    turn.text = "";
    props.streamingText = undefined;
    redraw();
    await rendered("└ Running command · $ git status");
    expect(screen).toContain("• Run command · Running");
    expect(callbacks.size).toBe(0);
    stdin.write("\x1b");
    await rendered("Press Esc again");
    stdin.write("\x1b");
    await rendered("Run command · Cancelled");
    expect(screen).not.toContain("Working ·");
    expect(screen).not.toContain("└ Running command");
    expect(callbacks.size).toBe(0);

    props.layout = "compact";
    props.entries = props.entries.slice(0, 1);
    props.busy = true;
    props.liveEntry = turn;
    props.animations = true;
    turn.toolCalls = [];
    time = 0;
    redraw();
    await rendered("⠋ Thinking");
    advance(100);
    await rendered("⠙ Thinking");
    const piComposerRow = promptRow();
    const piFooterRow = screen.split("\n").findIndex((row) => row.includes("ctx "));
    expect(piFooterRow).toBeGreaterThan(piComposerRow);

    turn.toolCalls = [
      { ...command, id: "command", progress: { progress: 1, total: 5, message: "Scanning" } },
      read,
    ];
    redraw();
    await rendered("⠙ Running 2 tools");
    await rendered("• Running command · 1/5 · $ git status · Scanning");
    expect(callbacks.size).toBe(1);
    turn.toolCalls = [
      { ...turn.toolCalls[0], progress: { progress: 4, total: 5, message: "Finishing" } },
      { ...read, status: "ok" },
    ];
    redraw();
    await rendered("• Run command · Running · 4/5 · $ git status · Finishing");
    expect(screen).not.toContain("1/5");
    expect(promptRow()).toBe(piComposerRow);

    turn.toolCalls = [
      { ...turn.toolCalls[0], status: "ok", output: "First result\nSecond result\nThird result" },
      turn.toolCalls[1],
    ];
    turn.text = "The checks finished.";
    props.streamingText = turn.text;
    redraw();
    await rendered("⠙ Answering");
    await rendered("2 more rows · Ctrl+O");
    expect(screen).toContain("First result");
    expect(screen).not.toContain("Second result");
    expect(screen).not.toContain("4/5");
    stdin.write("\x0f");
    await rendered("Third result");
    expect(promptRow()).toBe(piComposerRow);
    expect(screen.split("\n").findIndex((row) => row.includes("ctx "))).toBe(piFooterRow);

    turn.toolCalls = [command];
    props.animations = false;
    turn.text = "";
    props.streamingText = undefined;
    redraw();
    await rendered("● Running shell");
    expect(callbacks.size).toBe(0);
    stdout.columns = 40;
    stdout.rows = 16;
    stdout.emit("resize");
    await rendered("● Running shell");
    expect(screen.split("\n").every((row) => displayWidth(row) <= 40)).toBe(true);
    stdin.write("\x1b");
    await rendered("Press Esc again");
    stdin.write("\x1b");
    await rendered("Run command · Cancelled");
    expect(callbacks.size).toBe(0);
  } finally {
    app.unmount();
    app.cleanup();
    clock.dispose();
    if (previousTerminal === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerminal;
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
});
