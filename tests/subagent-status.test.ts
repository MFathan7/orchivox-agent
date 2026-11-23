import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import React from "react";

import type { SubagentWorkerState } from "../src/agent/subagent";
import { OrchivoxApp, type ChatToolCallView, type OrchivoxAppProps } from "../src/tui/app";
import { contrastRatio } from "../src/tui/motion";
import { subagentStatusRows } from "../src/tui/subagent-status";
import { displayWidth } from "../src/tui/text-wrap";
import { THEMES } from "../src/tui/theme";

function worker(id: string, description: string, phase: string): SubagentWorkerState {
  const now = Date.now();
  return {
    id, description, task: description, phase, parentSessionId: "session",
    status: "running", transcript: [], createdAt: now, updatedAt: now, lastProgressAt: now,
  };
}

test("worker rows fit, label stale activity, and leave failures visible", () => {
  const media = { ...worker("media", "Inspect media configuration in this project", "Waiting for provider"), lastProgressAt: 0 };
  const sysmon = worker("sysmon", "Inspect sysmon", "Running shell");
  const failed = { ...worker("failed", "Verify settings", "Reasoning"), status: "failed" as const };
  const options = { workers: [media, sysmon, failed], tasks: [], width: 38, detailLimit: 2 };

  const rows = subagentStatusRows(options);
  expect(rows.map(({ id }) => id)).toEqual(["summary", "worker:media", "worker:sysmon"]);
  expect(rows[0].text).toContain("1 failed");
  expect(rows[1].text).toContain("Stalled");
  expect(rows[2].text).toContain("Running shell");
  expect(rows.every(({ text }) => displayWidth(text) <= options.width)).toBe(true);
  expect(subagentStatusRows({ ...options, detailLimit: 1 })).toHaveLength(2);
  expect(subagentStatusRows({ ...options, width: 20 })).toHaveLength(1);
  expect(subagentStatusRows({ ...options, workers: [] })).toEqual([]);

  for (const theme of Object.values(THEMES)) {
    expect(contrastRatio(theme.text, theme.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.muted, theme.background)).toBeGreaterThanOrEqual(4.5);
  }
});

test("main activity and both worker phases stay visible through worker updates and terminal resize", async () => {
  const ready = Promise.withResolvers<void>();
  const hubReady = Promise.withResolvers<void>();
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
  }), { columns: 80, rows: 24 });
  const media = worker("media", "Inspect media", "Waiting for provider");
  const sysmon = worker("sysmon", "Inspect sysmon", "Running shell");
  const props: OrchivoxAppProps = {
    entries: [{ id: "request", role: "user", text: "Check media and sysmon." }],
    activeSessionId: "session",
    workers: [media, sysmon],
    busy: true,
    animations: false,
    onInteractionBlockedChange: (blocked) => { if (blocked) hubReady.resolve(); },
    liveEntry: {
      id: "live", role: "assistant", text: "",
      toolCalls: [{ id: "wait", name: "task_wait", argumentsSummary: "", status: "running", workerIds: ["media"] }],
    },
  };
  const app = render(React.createElement(OrchivoxApp, props), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
  });
  const screenShows = async (text: string) => {
    const deadline = Date.now() + 1000;
    while (!screen.includes(text) && Date.now() < deadline) await Bun.sleep(5);
    expect(screen).toContain(text);
  };

  try {
    await ready.promise;
    await screenShows("Main · Waiting for worker media");
    expect(screen).toContain("Inspect media · Waiting for provider");
    expect(screen).toContain("Inspect sysmon · Running shell");

    stdin.write("\x1ba");
    await hubReady.promise;
    await screenShows("Activity: Waiting for provider");
    stdin.write("\x1b[B");
    await screenShows("Activity: Running shell");
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.write("\x1b");
    await screenShows("Main · Waiting for worker media");

    stdout.columns = 40;
    stdout.rows = 16;
    stdout.emit("resize");
    app.rerender(React.createElement(OrchivoxApp, {
      ...props,
      currentTheme: "orbit-light",
      workers: [{ ...media, phase: "Answering" }, sysmon],
    }));
    await screenShows("Inspect media · Answering");
    expect(screen).toContain("Inspect sysmon · Running shell");
    expect(screen).toContain("Main · Waiting for worker media");
    expect(screen).toContain("Ask Orchivox");
    expect(screen.split("\n").length).toBeLessThanOrEqual(16);
    expect(screen.split("\n").every((line) => displayWidth(line) <= 40)).toBe(true);

    app.rerender(React.createElement(OrchivoxApp, {
      ...props,
      liveEntry: {
        id: "live", role: "assistant", text: "",
        toolCalls: [{ id: "read", name: "read_file", label: "Reading config", argumentsSummary: "", status: "running" }],
      },
    }));
    await screenShows("Main · Reading config");
    expect(screen).toContain("Inspect media · Waiting for provider");
    expect(screen).toContain("Inspect sysmon · Running shell");

    app.rerender(React.createElement(OrchivoxApp, {
      ...props, busy: false, liveEntry: undefined, workers: [{ ...media, status: "failed" }, sysmon],
    }));
    await screenShows("Main · Idle");
    expect(screen).toContain("1 failed");
    expect(screen).toContain("Inspect sysmon · Running shell");
    expect(screen).not.toContain("Inspect media · Answering");
  } finally {
    app.unmount();
    app.cleanup();
  }
});

test("parallel activity shows up to four tool and worker rows before results arrive", async () => {
  let screen = "";
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, done) {
      const frame = stripVTControlCharacters(chunk.toString());
      if (frame.includes("Ask Orchivox")) screen = frame;
      done();
    },
  }), { columns: 80, rows: 24 });
  const calls: ChatToolCallView[] = Array.from({ length: 5 }, (_, i) => ({
    id: `read-${i}`, name: "read_file", status: "running", argumentsSummary: "", filePath: `src/sample-${i}.ts`,
  }));
  const workers = [
    worker("config", "Check config", "Reading file"),
    worker("cache", "Check cache", "Searching code"),
    worker("tests", "Check tests", "Finding files"),
    worker("build", "Check build", "Running command"),
    worker("docs", "Check docs", "Reading document"),
  ];
  const view = (toolCalls: ChatToolCallView[], busy = true) => React.createElement(OrchivoxApp, {
    entries: [{ id: "request", role: "user", text: "Inspect the project." }],
    activeSessionId: "session",
    workers,
    busy,
    animations: false,
    liveEntry: busy ? { id: "live", role: "assistant", text: "", live: true, toolCalls } : undefined,
  });
  const app = render(view([]), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
  });
  const screenShows = async (text: string) => {
    const deadline = Date.now() + 1000;
    while (!screen.includes(text) && Date.now() < deadline) await Bun.sleep(5);
    expect(screen).toContain(text);
  };

  try {
    app.rerender(view(calls));
    await screenShows("Main · Running 5 tools");
    for (const call of calls.slice(0, 4)) expect(screen).toContain(`• Reading file · ${call.filePath}`);
    expect(screen).not.toContain("sample-4.ts");
    expect(screen).not.toContain("Check config · Reading file");

    const afterFirst: ChatToolCallView[] = [{ ...calls[0], status: "ok" }, ...calls.slice(1)];
    app.rerender(view(afterFirst));
    await screenShows("• Reading file · src/sample-4.ts");
    expect(screen).not.toContain("• Reading file · src/sample-0.ts");
    expect(screen).toContain("Done");

    const afterSecond: ChatToolCallView[] = [afterFirst[0], { ...calls[1], status: "error", output: "Read failed." }, ...calls.slice(2)];
    app.rerender(view(afterSecond));
    await screenShows("Check config · Reading file");
    expect(screen).toContain("3 tools");
    expect(screen).toContain("Read failed.");
    expect(screen).not.toContain("Check cache · Searching code");

    app.rerender(view([{
      id: "wait", name: "task_wait", argumentsSummary: "", status: "running", workerIds: ["build"],
    }]));
    await screenShows("Check build · Running command");
    expect(screen).toContain("Main · Waiting for worker build");
    expect(screen).not.toContain("Check docs · Reading document");

    stdout.columns = 40;
    stdout.rows = 16;
    stdout.emit("resize");
    app.rerender(view(afterSecond));
    await screenShows("Main · Running 3 tools");
    expect(screen.trimEnd().split("\n").length).toBeLessThanOrEqual(16);
    expect(screen.split("\n").every((row) => displayWidth(row) <= 40)).toBe(true);

    app.rerender(view([], false));
    await screenShows("Check cache · Searching code");
    expect(screen).not.toContain("sample-");
  } finally {
    app.unmount();
    app.cleanup();
  }
});
