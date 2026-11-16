import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { currentTurnContext } from "../agent/turn-context";
import { type HashlineLifecycle } from "../tools/hashline-edit";
import type { AgentTool, ToolRegistry } from "../tools/registry";
import { workspaceRoot } from "../tools/workspace";
import type { LSPClient, LSPTextEdit } from "./lsp-client";
import { sourceHash } from "./structural-search";
import { applyWorkspaceUpdates, workspaceEditIO, type WorkspaceEditIO } from "./workspace-edits";
import { ToolResultError } from "../tools/result";
import type { ToolOutput } from "../types/schema";
import { LspFailure } from "./lsp-status";

interface CodeAction { title: string; kind?: string; disabled?: { reason: string }; edit?: WorkspaceEdit; data?: unknown; command?: unknown }
interface WorkspaceEdit { changes?: Record<string, LSPTextEdit[]>; documentChanges?: Array<{ kind?: string; textDocument?: { uri: string }; edits?: LSPTextEdit[] }> }
interface Prepared { scope: string; filePath: string; hashes: Map<string, string>; action?: CodeAction; edits?: WorkspaceEdit; move?: { from: string; to: string } }

const PointSchema = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() });
const TextEditSchema = z.object({ range: z.object({ start: PointSchema, end: PointSchema }), newText: z.string() });
const WorkspaceEditSchema = z.object({
  changes: z.record(z.string(), z.array(TextEditSchema)).optional(),
  documentChanges: z.array(z.union([
    z.object({ kind: z.string().min(1) }).passthrough(),
    z.object({ textDocument: z.object({ uri: z.string() }), edits: z.array(TextEditSchema) }),
  ])).optional(),
});

export function parseWorkspaceEdit(value: unknown): WorkspaceEdit {
  const parsed = WorkspaceEditSchema.safeParse(value);
  if (!parsed.success) throw new LspFailure("invalid_response", "workspace-edit", "Language server returned an invalid workspace edit.");
  return parsed.data as WorkspaceEdit;
}

const scope = () => JSON.stringify([currentTurnContext()?.sessionId ?? currentTurnContext()?.runId ?? "standalone", currentTurnContext()?.workerId ?? "main", workspaceRoot(process.cwd())]);
const position = { filePath: z.string().min(1), line: z.number().int().positive(), column: z.number().int().positive() };

function fileFromUri(uri: string): string {
  if (!uri.startsWith("file:")) throw new Error("Language server returned a non-file edit.");
  return fileURLToPath(uri);
}
function inWorkspace(path: string): void {
  const rel = relative(workspaceRoot(process.cwd()), resolve(path));
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw new Error(`Language server edit is outside this workspace: ${path}`);
}
function apply(source: string, edits: LSPTextEdit[]): string {
  const offsets = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === "\n") offsets.push(index + 1);
  const offset = (point: { line: number; character: number }) => {
    if (point.line < 0 || point.line >= offsets.length || point.character < 0) throw new Error("Invalid language server edit range.");
    const end = point.line + 1 < offsets.length ? offsets[point.line + 1] - 1 : source.length;
    const result = offsets[point.line] + point.character;
    if (result > end) throw new Error("Language server edit extends past a line.");
    return result;
  };
  const ordered = edits.map((edit) => ({ start: offset(edit.range.start), end: offset(edit.range.end), text: edit.newText })).sort((a, b) => b.start - a.start);
  let boundary = source.length, next = source;
  for (const edit of ordered) {
    if (edit.end < edit.start || edit.end > boundary) throw new Error("Language server returned overlapping edit ranges.");
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
    boundary = edit.start;
  }
  return next;
}

export function registerLspActionTools(registry: ToolRegistry, client: LSPClient, lifecycle: HashlineLifecycle = {}, io: WorkspaceEditIO = workspaceEditIO): (filePath: string, edit: unknown, signal?: AbortSignal) => Promise<ToolOutput> {
  const prepared = new Map<string, Prepared>();
  const save = async (entry: Omit<Prepared, "hashes">, signal?: AbortSignal): Promise<string> => {
    const files = new Set([entry.filePath]);
    const rawEdit = entry.edits ?? entry.action?.edit;
    const edit = rawEdit === undefined ? undefined : parseWorkspaceEdit(rawEdit);
    for (const uri of Object.keys(edit?.changes ?? {})) files.add(fileFromUri(uri));
    for (const change of edit?.documentChanges ?? []) if (change.textDocument) files.add(fileFromUri(change.textDocument.uri));
    const hashes = new Map<string, string>();
    for (const file of files) {
      inWorkspace(file);
      const decision = await registry.authorize("read_file", { filePath: file }, signal);
      if (!decision.allowed) throw new Error(decision.reason ?? "An affected file cannot be inspected.");
      hashes.set(file, sourceHash(await io.read(file)));
    }
    if (prepared.size >= 100) prepared.delete(prepared.keys().next().value!);
    const id = crypto.randomUUID(); prepared.set(id, { ...entry, hashes }); return id;
  };
  registry.register({
    name: "lsp_code_actions", description: "List language-server quick fixes, import actions, and refactors at a position. Returns action IDs scoped to this agent/workspace; use lsp_apply_action to apply a selected action. Listing never executes server commands.",
    parameters: z.object({ ...position, only: z.array(z.string()).optional() }), readOnly: true, concurrency: "shared",
    async execute(args, context) {
      const input = args as z.infer<z.ZodObject<typeof position>> & { only?: string[] };
      const point = { line: input.line - 1, character: input.column - 1 };
      const actions = await client.protocolRequest("textDocument/codeAction", {
        textDocument: { uri: pathToFileURL(input.filePath).href }, range: { start: point, end: point },
        context: { diagnostics: [], ...(input.only ? { only: input.only } : {}) },
      }, context?.signal) as CodeAction[] | null;
      const results = [];
      for (const action of actions ?? []) results.push({ id: await save({ scope: scope(), filePath: input.filePath, action }, context?.signal), title: action.title, kind: action.kind, disabled: action.disabled?.reason });
      return { status: results.length ? "success" : "empty", text: JSON.stringify(results), sources: [{ uri: "lsp:textDocument/codeAction", title: "Language server" }] };
    },
  });
  registry.register({
    name: "lsp_preview_file_rename", description: "Ask the language server for import/reference edits required when moving one file. Returns an action ID for lsp_apply_action. Requires a server supporting workspace/willRenameFiles; does not guess import rewrites.",
    parameters: z.object({ sourcePath: z.string().min(1), destinationPath: z.string().min(1) }), readOnly: true, concurrency: "shared",
    async execute(args, context) {
      const input = args as { sourcePath: string; destinationPath: string };
      inWorkspace(input.sourcePath); inWorkspace(input.destinationPath);
      if (!(await stat(input.sourcePath)).isFile()) throw new Error("Only file renames are supported.");
      if (await Bun.file(input.destinationPath).exists()) throw new Error("Destination exists; no rename prepared.");
      const edits = await client.protocolRequest("workspace/willRenameFiles", { files: [{ oldUri: pathToFileURL(input.sourcePath).href, newUri: pathToFileURL(input.destinationPath).href }] }, context?.signal) as WorkspaceEdit | null;
      if (!edits) throw new Error("Language server did not prepare rename edits; no rename applied.");
      const id = await save({ scope: scope(), filePath: input.sourcePath, edits, move: { from: input.sourcePath, to: input.destinationPath } }, context?.signal);
      const previews = Object.entries(edits.changes ?? {}).flatMap(([uri, changes]) => changes.map((change) => ({ filePath: fileFromUri(uri), range: change.range, newText: change.newText.slice(0, 500), truncated: change.newText.length > 500 })));
      for (const change of edits.documentChanges ?? []) if (change.textDocument && change.edits) for (const edit of change.edits) previews.push({ filePath: fileFromUri(change.textDocument.uri), range: edit.range, newText: edit.newText.slice(0, 500), truncated: edit.newText.length > 500 });
      return { status: previews.length > 30 ? "partial" : "success", text: JSON.stringify({ id, sourcePath: input.sourcePath, destinationPath: input.destinationPath, editCount: previews.length, preview: previews.slice(0, 30), partial: previews.length > 30 }), sources: [{ uri: "lsp:workspace/willRenameFiles", title: "Language server" }], ...(previews.length > 30 ? { reason: "Preview limited to the first 30 edits; applying still validates all affected files." } : {}) };
    },
  });
  const applyAction: AgentTool<z.ZodTypeAny, ToolOutput> = {
    name: "lsp_apply_action", description: "Apply a selected lsp_code_actions or lsp_preview_file_rename action. All affected file permissions are checked before writing. Only text edits and a prepared file move are supported; command-only actions and resource creation/deletion are rejected.",
    parameters: z.object({ id: z.string().min(1), filePath: z.string().min(1) }), readOnly: false,
    async execute(args, context) {
      const input = args as { id: string; filePath: string };
      const entry = prepared.get(input.id);
      if (!entry || entry.scope !== scope() || resolve(entry.filePath) !== resolve(input.filePath)) throw new Error("Unknown action for this agent/file; list actions again.");
      for (const [file, hash] of entry.hashes) if (sourceHash(await io.read(file)) !== hash) throw new ToolResultError({ status: "error", code: "stale_edit", text: "An affected file changed since the action was listed; list actions again." });
      let action = entry.action;
      if (action?.disabled) throw new Error(action.disabled.reason);
      if (action && !action.edit && action.data !== undefined) action = await client.protocolRequest("codeAction/resolve", action, context?.signal) as CodeAction;
      if (action?.command) throw new Error("This action requires executing a server command; use an explicitly approved execution workflow instead.");
      const rawEdit = entry.edits ?? action?.edit;
      if (rawEdit === undefined) throw new Error("This action contains no supported workspace edits.");
      const edit = parseWorkspaceEdit(rawEdit);
      const byFile = new Map<string, LSPTextEdit[]>();
      const add = (uri: string, edits: LSPTextEdit[]) => { const file = fileFromUri(uri); inWorkspace(file); byFile.set(file, [...(byFile.get(file) ?? []), ...edits]); };
      for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(uri, edits);
      for (const change of edit.documentChanges ?? []) {
        if (change.kind || !change.textDocument || !change.edits) throw new Error("Resource operations are not supported; no edits applied.");
        add(change.textDocument.uri, change.edits);
      }
      const updates = [];
      for (const [file, edits] of byFile) {
        context?.signal?.throwIfAborted();
        const readable = await registry.authorize("read_file", { filePath: file }, context?.signal);
        if (!readable.allowed) throw new Error(readable.reason ?? "An affected file cannot be inspected; no edits applied.");
        const before = await io.read(file);
        updates.push({ file, before, after: apply(before, edits) });
      }
      for (const update of updates) {
        const decision = await registry.authorize("create_file", { filePath: update.file, content: update.after }, context?.signal);
        if (!decision.allowed) throw new Error(decision.reason ?? "An affected file was denied; no edits applied.");
      }
      if (entry.move) {
        if (await Bun.file(entry.move.to).exists()) throw new Error("Destination now exists; no edits applied.");
        for (const [name, args] of [
          ["create_file", { filePath: entry.move.to, content: await io.read(entry.move.from) }],
          ["delete_file", { filePath: entry.move.from }],
        ] as const) {
          const decision = await registry.authorize(name, args, context?.signal);
          if (!decision.allowed) throw new Error(decision.reason ?? "File move denied; no edits applied.");
        }
        const decision = await registry.authorize("move_file", { sourcePath: entry.move.from, destinationPath: entry.move.to }, context?.signal);
        if (!decision.allowed) throw new Error(decision.reason ?? "File move denied; no edits applied.");
      }
      for (const [file, hash] of entry.hashes) if (sourceHash(await io.read(file)) !== hash) throw new ToolResultError({ status: "error", code: "stale_edit", text: "An affected file changed during preparation; no edits applied." });
      const move = entry.move ? { ...entry.move, before: await io.read(entry.move.from) } : undefined;
      if (move && sourceHash(move.before) !== entry.hashes.get(move.from)) throw new ToolResultError({ status: "error", code: "stale_edit", text: "Move source changed during preparation; no edits applied." });
      return applyWorkspaceUpdates({
        updates, move, lifecycle, signal: context?.signal, io,
        consume: () => {
          if (prepared.get(input.id) !== entry) throw new Error("Action was already consumed; inspect the previous result before preparing another action.");
          prepared.delete(input.id);
        },
        afterMove: entry.move ? () => client.protocolNotify("workspace/didRenameFiles", { files: [{ oldUri: pathToFileURL(entry.move!.from).href, newUri: pathToFileURL(entry.move!.to).href }] }) : undefined,
      });
    },
  };
  registry.register(applyAction);
  return async (filePath, edit, signal) => {
    const id = await save({ scope: scope(), filePath, edits: edit as WorkspaceEdit }, signal);
    return applyAction.execute({ id, filePath }, { signal });
  };
}
