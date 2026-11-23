import { expect, test } from "bun:test";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import React from "react";

import { AgentOrchestrator } from "../src/agent/orchestrator";
import { AgentRunRequestSchema } from "../src/api/server";
import { AppConfigSchema } from "../src/config/loader";
import { RulesLoader } from "../src/memory/rules-loader";
import { MemoryDatabase } from "../src/memory/sqlite";
import { ProviderRouter } from "../src/provider/router";
import { resolveProjectState } from "../src/runtime-paths";
import { OrchivoxApp, type OrchivoxAppProps } from "../src/tui/app";
import { buildTranscriptEntries } from "../src/tui/transcript";
import { displayWidth } from "../src/tui/text-wrap";
import { ReplyChanges, ReplyChangesConflict, replyFileDiff, revertReplyChanges } from "../src/vcs/reply-changes";
import { SnapshotManager } from "../src/vcs/snapshot";
import { WorktreeManager } from "../src/vcs/worktree";

test("recorded edits through the agent restore exact prior bytes and persist the review", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchivox-reply-edits-"));
  const database = new MemoryDatabase(":memory:");
  const session = database.createSession({ title: "Review integration", mode: "build" });
  const receipt = new ReplyChanges(root);
  const model = { provider: "test", model: "test-model" };
  const config = AppConfigSchema.parse({
    providers: { test: { kind: "openai", base_url: "http://127.0.0.1:1", models: [model.model] } },
    roles: { main_model: model },
  });
  const router = new ProviderRouter(config);
  const original = "local user work\r\n";
  const binary = Uint8Array.of(0, 255, 12);
  const commands = [
    { name: "replace_text", arguments: { filePath: "notes.txt", oldString: "local", newString: "draft" } },
    { name: "replace_text", arguments: { filePath: "notes.txt", oldString: "draft", newString: "final" } },
    { name: "create_file", arguments: { filePath: "empty.txt", content: "" } },
    { name: "delete_file", arguments: { filePath: "removed.txt" } },
    { name: "move_file", arguments: { sourcePath: "data.bin", destinationPath: "renamed.bin" } },
  ];
  let step = 0;
  router.provider = () => ({
    async *streamChat() {
      const command = commands[step++];
      if (command) yield { type: "tool_call_ready", id: `tool-${step}`, ...command };
      else yield { type: "token", text: "Finished updating the files." };
    },
    async listModels() { return [model.model]; },
  });
  const agent = new AgentOrchestrator({
    router, database, repoRoot: root, config,
    worktrees: new WorktreeManager({ repoRoot: root, worktreesDir: root }),
    snapshots: new SnapshotManager({ repoRoot: root, stateDir: root }),
    rules: new RulesLoader({ rootPath: root }),
  });
  try {
    await writeFile(join(root, "notes.txt"), original);
    await writeFile(join(root, "removed.txt"), "deleted by the reply");
    await writeFile(join(root, "data.bin"), binary);
    await writeFile(join(root, "unrelated.txt"), "only mine");
    const events = [];
    for await (const event of agent.runStream(AgentRunRequestSchema.parse({
      profile: "orchivox-main",
      metadata: { session_id: session.id },
      messages: [{ id: "request", role: "user", content: [{ type: "text", text: "Update the files." }] }],
    }), undefined, receipt)) events.push(event);
    expect(events.filter((event) => event.type === "tool_end").map((event) => event.status)).toEqual(commands.map(() => "ok"));
    expect(receipt.finish().map(({ path }) => path)).toEqual(["notes.txt", "empty.txt", "removed.txt", "data.bin", "renamed.bin"]);
    const reply = { id: "saved-reply", role: "assistant" as const, content: [{ type: "text" as const, text: "Finished updating the files." }] };
    database.saveMessage(session.id, reply, receipt.finish());
    expect(database.loadFullMessages(session.id).find(({ id }) => id === reply.id)?.metadata).toEqual({ reply_change_count: 5 });
    const fork = database.forkSession(session.id);
    expect(buildTranscriptEntries(database.loadFullMessages(fork.id)).some(({ replyChangeCount }) => replyChangeCount)).toBe(false);
    const saved = database.loadReplyChanges(session.id, reply.id)!;
    expect(replyFileDiff(saved.files[0])).toEqual({ before: original, after: "final user work\r\n" });
    expect(replyFileDiff(saved.files[3])).toBeUndefined();

    await writeFile(join(root, "notes.txt"), "new manual work");
    const mark = () => database.markReplyChangesReverted(session.id, reply.id);
    expect(() => revertReplyChanges(root, saved.files, mark)).toThrow(ReplyChangesConflict);
    expect(await Bun.file(join(root, "renamed.bin")).exists()).toBe(true);
    expect(await Bun.file(join(root, "notes.txt")).text()).toBe("new manual work");
    expect(database.loadReplyChanges(session.id, reply.id)?.reverted).toBe(false);

    await writeFile(join(root, "notes.txt"), "final user work\r\n");
    expect(() => revertReplyChanges(root, saved.files, () => { throw new Error("database save failed"); })).toThrow("database save failed");
    expect(await Bun.file(join(root, "notes.txt")).text()).toBe("final user work\r\n");
    expect(await Bun.file(join(root, "empty.txt")).exists()).toBe(true);
    expect(await Bun.file(join(root, "removed.txt")).exists()).toBe(false);
    expect(await Bun.file(join(root, "renamed.bin")).exists()).toBe(true);

    revertReplyChanges(root, saved.files, mark);
    expect(await Bun.file(join(root, "notes.txt")).text()).toBe(original);
    expect(await Bun.file(join(root, "empty.txt")).exists()).toBe(false);
    expect(await Bun.file(join(root, "removed.txt")).text()).toBe("deleted by the reply");
    expect(new Uint8Array(await readFile(join(root, "data.bin")))).toEqual(binary);
    expect(await Bun.file(join(root, "renamed.bin")).exists()).toBe(false);
    expect(await Bun.file(join(root, "unrelated.txt")).text()).toBe("only mine");
    expect(database.loadReplyChanges(session.id, reply.id)?.reverted).toBe(true);
    expect(buildTranscriptEntries(database.loadFullMessages(session.id)).find(({ replyChangeId }) => replyChangeId === reply.id)).toMatchObject({
      replyChangeCount: 5, replyChangesReverted: true,
    });
  } finally {
    await agent.closeToolRuntimes();
    database.close();
    await Promise.allSettled(["notes.txt", "empty.txt", "removed.txt", "data.bin", "renamed.bin", "unrelated.txt"].map((name) => unlink(join(root, name))));
    await rmdir(root);
  }
});

test("the review excludes net-zero edits and blocks undo when a file changed between recorded writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchivox-reply-conflict-"));
  const path = join(root, "file.txt");
  try {
    const record = new ReplyChanges(root);
    record.beforeWrite(path);
    await writeFile(path, "new");
    record.afterWrite(path, "new");
    record.beforeWrite(path);
    await unlink(path);
    record.afterWrite(path, null);
    expect(record.finish()).toEqual([]);

    const changed = new ReplyChanges(root);
    changed.beforeWrite(path);
    await writeFile(path, "first edit");
    changed.afterWrite(path, "first edit");
    await writeFile(path, "user edit between writes");
    changed.beforeWrite(path);
    await writeFile(path, "second edit");
    changed.afterWrite(path, "second edit");
    expect(() => revertReplyChanges(root, changed.finish(), () => undefined)).toThrow("changed between recorded edits");
    expect(await Bun.file(path).text()).toBe("second edit");
  } finally {
    await unlink(path).catch(() => undefined);
    await rmdir(root);
  }
});

test("review opens from the reply footer, shows diffs, and confirms group undo in a narrow terminal", async () => {
  const stateHome = process.env.ORCHIVOX_STATE_HOME;
  const root = await mkdtemp(join(tmpdir(), "orchivox-review-ui-"));
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
  const undoIds: string[] = [];
  let conflict = true;
  const props: OrchivoxAppProps = {
    animations: false,
    currentTheme: "paper",
    entries: [
      { id: "entry-1", replyChangeId: "earlier", role: "assistant", text: "An earlier edit.", replyChangeCount: 1 },
      { id: "entry-2", replyChangeId: "reply", role: "assistant", text: "Finished updating the files.", replyChangeCount: 2 },
    ],
    loadReplyChanges(id) {
      const after = { bytes: Buffer.from("new contents\n").toString("base64"), mode: 0o644 };
      const files = id === "earlier" ? [{ path: "earlier.txt", before: null, after }] : [
        { path: "first.txt", before: { bytes: Buffer.from("old contents\n").toString("base64"), mode: 0o644 }, after },
        { path: "second.txt", before: null, after },
      ];
      const reverted = props.entries?.find((entry) => entry.replyChangeId === id)?.replyChangesReverted ?? false;
      return { files, reverted };
    },
    onUndoReplyChanges(id) {
      if (conflict) throw new ReplyChangesConflict(["second.txt"]);
      undoIds.push(id);
      props.entries = props.entries?.map((entry) => entry.replyChangeId === id ? { ...entry, replyChangesReverted: true } : entry);
      redraw();
    },
  };
  const app = render(React.createElement(OrchivoxApp, props), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
  });
  const redraw = () => app.rerender(React.createElement(OrchivoxApp, props));
  const waitFor = async (expected: string, checkBounds = true) => {
    const deadline = Date.now() + 1600;
    while (!screen.includes(expected) && Date.now() < deadline) await Bun.sleep(5);
    expect(screen).toContain(expected);
    if (checkBounds) {
      expect(screen.split("\n").length).toBeLessThanOrEqual(stdout.rows);
      expect(screen.split("\n").every((line) => displayWidth(line) <= stdout.columns)).toBe(true);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const key = async (input: string, expected: string) => {
    stdin.write(input);
    await waitFor(expected);
  };
  try {
    await ready.promise;
    await waitFor("Ctrl+R review");
    await key("\x12", "Review changes");
    await key("\x1b[D", "earlier.txt");
    await key("\x1b[C", "first.txt");
    await key("\r", "old contents");
    expect(screen).toContain("new contents");
    await key("\x1b", "Enter diff");
    await key("u", "Undo changes to 2 files?");
    await key("\x1b", "Enter diff");
    expect(undoIds).toEqual([]);
    await key("u", "Undo changes to 2 files?");
    await key("\r", "Conflict  second.txt");
    expect(undoIds).toEqual([]);
    conflict = false;
    await key("u", "Undo changes to 2 files?");
    await key("\r", "Changes reverted");
    expect(undoIds).toEqual(["reply"]);
    await key("\x1b", "Changes reverted · Ctrl+R review");
    expect(screen).toContain("Finished updating the files.");
    stdout.columns = 92;
    stdout.rows = 24;
    props.currentTheme = "tokyonight";
    stdout.emit("resize");
    redraw();
    stdin.write("/changes");
    await waitFor("/changes", false);
    await key("\r", "Review changes");
    await key("\x1b", "Changes reverted · Ctrl+R review");
    props.entries = [];
    redraw();
    await key("\x12", "No reply changes to review.");
  } finally {
    app.unmount();
    app.cleanup();
    if (stateHome === undefined) delete process.env.ORCHIVOX_STATE_HOME;
    else process.env.ORCHIVOX_STATE_HOME = stateHome;
    if (await Bun.file(history).exists()) await unlink(history);
    await rmdir(dataDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(root);
  }
});
