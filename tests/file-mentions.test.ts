import { expect, test } from "bun:test";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import React from "react";

import { PromptComposer, type PromptSubmitPayload } from "../src/tui/composer";
import { queuedInputText } from "../src/tui/input-routing";

test("composer submits file mentions by path and still attaches images", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchivox-mentions-"));
  const textPath = join(root, "notes.txt");
  const imagePath = join(root, "preview.png");
  const original = "Compare @notes.txt and @notes.txt:2-3 with @preview.png when ready.";
  const fileBody = "test file body\nsecond line\nthird line";
  const legacy = {
    raw: "@notes.txt",
    filePath: "notes.txt",
    exists: true,
    kind: "text" as const,
    context: `--- File Context: notes.txt (3 lines) ---\n${fileBody}`,
  };
  const ready = Promise.withResolvers<void>();
  const submitted = Promise.withResolvers<PromptSubmitPayload>();
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (enabled: boolean) => { if (enabled) ready.resolve(); },
    ref() {},
    unref() {},
  });
  const stdout = Object.assign(new Writable({ write: (_chunk, _encoding, callback) => callback() }), { columns: 100 });

  try {
    await writeFile(textPath, fileBody);
    await writeFile(imagePath, Uint8Array.of(137, 80, 78, 71));
    const app = render(React.createElement(PromptComposer, {
      initialText: original,
      initialAttachments: [legacy],
      repoRoot: root,
      onSubmit: (payload) => { submitted.resolve(payload); return false; },
    }), { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false });
    const timeout = AbortSignal.timeout(3000);
    const failed = app.waitUntilExit().then(() => { throw new Error("Composer exited before submission."); });
    const expired = new Promise<never>((_resolve, reject) => timeout.addEventListener("abort", () => reject(timeout.reason), { once: true }));
    try {
      await Promise.race([ready.promise, failed, expired]);
      stdin.write("\r");
      const payload = await Promise.race([submitted.promise, failed, expired]);
      expect(payload.rawText).toBe(original);
      expect(payload.attachments).toMatchObject([
        { filePath: "notes.txt", exists: true, kind: "text" },
        { filePath: "notes.txt", startLine: 2, endLine: 3, kind: "text" },
        { filePath: "preview.png", kind: "image", base64: "iVBORw==" },
      ]);
      expect(JSON.stringify(payload)).not.toContain("File Context");
      expect(JSON.stringify(payload)).not.toContain(fileBody.split("\n")[0]);
    } finally {
      app.unmount();
      app.cleanup();
    }
  } finally {
    await Promise.allSettled([unlink(textPath), unlink(imagePath)]);
    await rmdir(root);
  }
});

test("a saved queue item's original action omits previously injected file contents", () => {
  const original = "Read @notes.txt:2-3";
  const input = {
    text: `${original}\n\n--- File Context: notes.txt:2-3 (2 lines) ---\nold file contents`,
    action: { kind: "submit" as const, text: original, ultrawork: false },
  };
  expect(queuedInputText(input)).toBe(original);
  const command = "/study @notes.txt";
  expect(queuedInputText({
    ...input,
    action: { kind: "command", command: "/study", raw: command },
  })).toBe(command);
});
