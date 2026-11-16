import { lstat, rename } from "node:fs/promises";
import type { ToolOutput } from "../types/schema";
import { readText, type HashlineLifecycle } from "../tools/hashline-edit";
import { ToolResultError } from "../tools/result";
import { sourceHash } from "./structural-search";

export interface WorkspaceEditIO {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<unknown>;
  move(from: string, to: string): Promise<unknown>;
  exists(path: string): Promise<boolean>;
}
export const workspaceEditIO: WorkspaceEditIO = {
  read: readText, write: (path, text) => Bun.write(path, text), move: rename,
  exists: async (path) => {
    try { await lstat(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  },
};
export interface TextUpdate { file: string; before: string; after: string }
type FileState = "not_attempted" | "unchanged" | "changed" | "uncertain";

export async function applyWorkspaceUpdates(options: {
  updates: TextUpdate[];
  move?: { from: string; to: string; before: string };
  lifecycle?: HashlineLifecycle;
  signal?: AbortSignal;
  consume?: () => void;
  afterMove?: () => void;
  io?: WorkspaceEditIO;
}): Promise<ToolOutput> {
  const { updates, move, signal, lifecycle = {}, io = workspaceEditIO } = options;
  const files = updates.map((update) => ({ filePath: update.file, state: "not_attempted" as FileState, issue: undefined as string | undefined }));
  const movement = move ? { from: move.from, to: move.to, state: "not_attempted" as FileState, issue: undefined as string | undefined } : undefined;
  let currentPath = "";
  let active: typeof files[number] | undefined;
  let activeUpdate: TextUpdate | undefined;
  let writing = false, moving = false, stage = "preflight";
  const issues: Array<{ stage: string; filePath: string; message: string }> = [];
  const recordMove = async (expected: string) => {
    if (!move) return;
    for (const [name, callback] of [
      ["notify_move", options.afterMove],
      ["after_move_source", () => lifecycle.onAfterModify?.(move.from, "")],
      ["after_move_destination", () => lifecycle.onAfterModify?.(move.to, expected)],
    ] as const) {
      try { await callback?.(); }
      catch (error) { issues.push({ stage: name, filePath: move.to, message: error instanceof Error ? error.message : String(error) }); }
    }
  };
  let failureCode: string | undefined;
  let cancelled = false;
  try {
    signal?.throwIfAborted();
    for (const file of new Set([...updates.map((update) => update.file), ...(move ? [move.from, move.to] : [])])) {
      currentPath = file;
      signal?.throwIfAborted();
      await lifecycle.onBeforeModify?.(file);
    }
    for (const update of updates) {
      currentPath = update.file;
      signal?.throwIfAborted();
      if (sourceHash(await io.read(update.file)) !== sourceHash(update.before)) throw new ToolResultError({ status: "error", code: "stale_edit", reason: `An affected file changed; no edits applied: ${update.file}` });
    }
    if (move) {
      currentPath = move.from;
      if (await io.exists(move.to)) throw new ToolResultError({ status: "error", code: "destination_exists", reason: "Destination now exists; no edits applied." });
      if (sourceHash(await io.read(move.from)) !== sourceHash(move.before)) throw new ToolResultError({ status: "error", code: "stale_edit", reason: "Move source changed; no edits applied." });
    }
    signal?.throwIfAborted();
    options.consume?.();
    for (const [index, update] of updates.entries()) {
      active = files[index]; activeUpdate = update; currentPath = update.file; stage = "before_write";
      signal?.throwIfAborted();
      if (sourceHash(await io.read(update.file)) !== sourceHash(update.before)) throw new ToolResultError({ status: "error", code: "stale_edit", reason: `File changed before its write: ${update.file}` });
      if (update.after === update.before) { active!.state = "unchanged"; continue; }
      stage = "write"; writing = true;
      await io.write(update.file, update.after);
      active!.state = "changed"; writing = false; stage = "after_write";
      await lifecycle.onAfterModify?.(update.file, update.after);
    }
    active = undefined;
    signal?.throwIfAborted();
    if (move && movement) {
      stage = "before_move"; currentPath = move.from;
      const expected = updates.find((update) => update.file === move.from)?.after ?? move.before;
      if (await io.exists(move.to)) throw new ToolResultError({ status: "error", code: "destination_exists", reason: "Move destination appeared after text edits." });
      if (sourceHash(await io.read(move.from)) !== sourceHash(expected)) throw new ToolResultError({ status: "error", code: "stale_edit", reason: "Move source changed after text edits." });
      signal?.throwIfAborted();
      stage = "move"; moving = true;
      await io.move(move.from, move.to);
      movement.state = "changed"; moving = false;
      await recordMove(expected);
    }
    signal?.throwIfAborted();
  } catch (error) {
    cancelled = signal?.aborted === true || (error instanceof Error && error.name === "AbortError") || (error instanceof ToolResultError && error.output.status === "cancelled");
    failureCode = error instanceof ToolResultError ? error.output.code : "workspace_edit_failed";
    const message = error instanceof Error ? error.message : String(error);
    if (active) active.issue = message;
    if (movement && (moving || stage === "before_move")) movement.issue = message;
    issues.push({ stage, filePath: active?.filePath ?? currentPath, message });
    if (writing && active && activeUpdate) {
      try {
        const observed = await io.read(activeUpdate.file);
        active.state = observed === activeUpdate.after ? "changed" : observed === activeUpdate.before ? "unchanged" : "uncertain";
        if (observed !== activeUpdate.before) {
          try { await lifecycle.onAfterModify?.(activeUpdate.file, observed); }
          catch (error) { issues.push({ stage: "reconcile_write", filePath: activeUpdate.file, message: error instanceof Error ? error.message : String(error) }); }
        }
      } catch { active.state = "uncertain"; }
    }
    if (moving && move && movement) {
      const expected = updates.find((update) => update.file === move.from)?.after ?? move.before;
      try {
        if (!(await io.exists(move.from)) && await io.exists(move.to) && await io.read(move.to) === expected) movement.state = "changed";
        else if (!(await io.exists(move.to)) && await io.read(move.from) === expected) movement.state = "unchanged";
        else movement.state = "uncertain";
      } catch { movement.state = "uncertain"; }
      if (movement.state === "changed") await recordMove(expected);
    }
  }
  const changedFiles = files.filter((file) => file.state === "changed").map((file) => file.filePath);
  const hasChanges = changedFiles.length > 0 || movement?.state === "changed";
  const uncertain = files.some((file) => file.state === "uncertain") || movement?.state === "uncertain";
  const status = cancelled ? "cancelled" : issues.length ? hasChanges || uncertain ? "partial" : "error" : hasChanges ? "success" : "empty";
  return {
    status, ...(failureCode ? { code: failureCode } : issues.length ? { code: "post_write_failed" } : {}),
    text: `Confirmed text-file changes: ${changedFiles.length}.${uncertain ? " Some file states remain uncertain." : ""}${movement?.state === "changed" ? " File move completed." : ""}`,
    ...(issues.length ? { reason: `${issues.map((issue) => issue.message).join(" ")} Completed changes were retained. Inspect file states before preparing another action; this action was not retried.` } : {}),
    data: JSON.parse(JSON.stringify({ changedFiles, files, ...(movement ? { move: movement, ...(movement.state === "changed" ? { moved: { from: movement.from, to: movement.to } } : {}) } : {}), issues, retrySafe: false })),
    coverage: { scope: "Prepared language-server workspace edits", complete: !issues.length, returned: changedFiles.length, total: updates.length, unit: "text files" },
    sources: [{ uri: "lsp:workspace-edit", title: "Language server edits applied to local files" }],
  };
}
