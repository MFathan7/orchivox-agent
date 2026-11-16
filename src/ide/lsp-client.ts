import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

import type { AgentTool, ToolRegistry } from "../tools/registry";
import { StdioFramedTransport } from "./framing";
import type { HashlineLifecycle } from "../tools/hashline-edit";
import { parseWorkspaceEdit, registerLspActionTools } from "./lsp-actions";
import { LspFailure, lspFailure } from "./lsp-status";
import type { ToolOutput } from "../types/schema";
import { applyWorkspaceUpdates } from "./workspace-edits";
import { ToolResultError } from "../tools/result";

export interface LSPDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  code?: string;
  source?: string;
}

export interface LSPTextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

export interface LSPWorkspaceSymbol {
  name: string;
  kind: string;
  containerName?: string;
  file: string;
  line?: number;
  column?: number;
  uri?: string;
}

export interface LSPClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  diagnosticTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface RawRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface RawDiagnostic {
  range: RawRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

interface WorkspaceEdit {
  changes?: Record<string, LSPTextEdit[]>;
  documentChanges?: Array<{ textDocument?: { uri?: string }; edits?: LSPTextEdit[] }>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const SEVERITIES = ["error", "warning", "info", "hint"] as const;

export class LSPClient {
  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string> | undefined;
  private readonly diagnosticTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private transport: StdioFramedTransport | undefined;
  private serverCapabilities: unknown;
  private initialized = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly latestDiagnostics = new Map<string, LSPDiagnostic[]>();
  private readonly diagnosticWaiters = new Map<string, Array<{ resolve: (diagnostics: LSPDiagnostic[]) => void; reject: (error: Error) => void }>>();
  private readonly openDocuments = new Set<string>();
  private readonly documentVersions = new Map<string, number>();

  constructor(options: LSPClientOptions) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.env = options.env;
    this.diagnosticTimeoutMs = options.diagnosticTimeoutMs ?? 250;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async initialize(workspaceRoot: string, signal?: AbortSignal): Promise<void> {
    if (this.transport) throw new Error("language client is already initialized");
    try { this.transport = new StdioFramedTransport(this.command, this.args, { env: this.env }); }
    catch (error) { throw new LspFailure("not_ready", "initialize", error instanceof Error ? error.message : String(error)); }
    this.transport.onMessage((message) => this.handleMessage(message));
    const activeTransport = this.transport;
    this.transport.onClose((error) => {
      if (this.transport !== activeTransport) return;
      this.initialized = false;
      for (const pending of [...this.pending.values()]) pending.reject(new LspFailure("server_exited", "transport", error.message));
      for (const waiters of [...this.diagnosticWaiters.values()]) for (const waiter of [...waiters]) waiter.reject(new LspFailure("server_exited", "diagnostics", error.message));
    });

    const rootUri = pathToFileURL(workspaceRoot).toString();
    try {
      const result = (await this.request("initialize", {
        processId: globalThis.process.pid ?? null,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: workspaceRoot.split(/[\\/]/).pop() ?? workspaceRoot }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: true },
            publishDiagnostics: {},
            rename: { prepareSupport: false },
            definition: {},
            references: {},
            codeAction: { resolveSupport: { properties: ["edit"] } },
          },
          workspace: { workspaceFolders: true, fileOperations: { willRename: true, didRename: true } },
        },
      }, signal)) as { capabilities?: unknown };
      if (!result || typeof result !== "object") throw new LspFailure("invalid_response", "initialize", "Language server returned an invalid initialize response.");
      this.serverCapabilities = result.capabilities ?? {};
      this.notify("initialized", {});
      this.initialized = true;
    } catch (error) {
      await this.transport.close();
      this.transport = undefined;
      throw lspFailure(error, "initialize", signal);
    }
  }

  async notifyFileChanged(filePath: string, newContent: string, signal?: AbortSignal): Promise<LSPDiagnostic[]> {
    if (signal?.aborted) throw new LspFailure("cancelled", "diagnostics", "Language server diagnostics cancelled.");
    const transport = this.assertReady();
    const uri = pathToFileURL(filePath).toString();
    const version = (this.documentVersions.get(uri) ?? 0) + 1;
    this.documentVersions.set(uri, version);
    const waiting = this.awaitDiagnostics(uri, signal);
    void waiting.catch(() => {});
    try {
      if (!this.openDocuments.has(uri)) {
        this.openDocuments.add(uri);
        transport.send({
          jsonrpc: "2.0",
          method: "textDocument/didOpen",
          params: {
            textDocument: { uri, languageId: languageIdFor(filePath), version, text: newContent },
          },
        });
      } else {
        transport.send({
          jsonrpc: "2.0",
          method: "textDocument/didChange",
          params: {
            textDocument: { uri, version },
            contentChanges: [{ text: newContent }],
          },
        });
      }
    } catch (error) {
      for (const waiter of [...(this.diagnosticWaiters.get(uri) ?? [])]) waiter.reject(lspFailure(error, "diagnostics", signal));
    }
    return waiting;
  }

  async definition(filePath: string, line: number, column: number, signal?: AbortSignal): Promise<string[]> {
    const result = await this.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(filePath).toString() },
      position: { line: line - 1, character: column - 1 },
    }, signal);
    return formatLocations(result);
  }

  async references(filePath: string, line: number, column: number, includeDeclaration = true, signal?: AbortSignal): Promise<string[]> {
    const result = await this.request("textDocument/references", {
      textDocument: { uri: pathToFileURL(filePath).toString() },
      position: { line: line - 1, character: column - 1 },
      context: { includeDeclaration },
    }, signal);
    return formatLocations(result);
  }

  async rename(filePath: string, line: number, column: number, newName: string): Promise<string[]> {
    const result = (await this.request("textDocument/rename", {
      textDocument: { uri: pathToFileURL(filePath).toString() },
      position: { line: line - 1, character: column - 1 },
      newName,
    })) as WorkspaceEdit | null;
    if (result === null) return [];
    const editsByFile = collectWorkspaceEdits(parseWorkspaceEdit(result));
    const updates = [];
    for (const [file, edits] of editsByFile) {
      const handle = Bun.file(file);
      const content = (await handle.exists()) ? await handle.text() : "";
      updates.push({ file, before: content, after: applyTextEdits(content, edits) });
    }
    const outcome = await applyWorkspaceUpdates({ updates });
    if (outcome.status !== "success" && outcome.status !== "empty") throw new ToolResultError(outcome);
    return (outcome.data as { changedFiles: string[] }).changedFiles;
  }

  isReady(): boolean {
    return this.initialized && this.transport?.isOpen() === true;
  }

  async hover(filePath: string, line: number, column: number, signal?: AbortSignal): Promise<string | null> {
    const result = await this.request("textDocument/hover", {
      textDocument: { uri: pathToFileURL(filePath).toString() },
      position: { line: line - 1, character: column - 1 },
    }, signal);
    return formatHover(result);
  }

  async workspaceSymbols(query: string, signal?: AbortSignal): Promise<LSPWorkspaceSymbol[]> {
    const result = await this.request("workspace/symbol", { query }, signal);
    return formatWorkspaceSymbols(result);
  }

  registerTools(registry: ToolRegistry, lifecycle: HashlineLifecycle = {}): void {
    const applyEdit = registerLspActionTools(registry, this, lifecycle);
    registry.register(this.renameTool(applyEdit));
    registry.register(this.definitionTool());
    registry.register(this.referencesTool());
  }

  protocolRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> { return this.request(method, params, signal); }
  protocolNotify(method: string, params: unknown): void { this.notify(method, params); }

  async dispose(): Promise<void> {
    if (!this.transport) return;
    for (const pending of this.pending.values()) pending.reject(new LspFailure("not_ready", "dispose", "Language client disposed."));
    this.pending.clear();
    for (const waiters of [...this.diagnosticWaiters.values()]) for (const waiter of [...waiters]) waiter.reject(new LspFailure("not_ready", "diagnostics", "Language client disposed."));
    try {
      await this.request("shutdown", null, AbortSignal.timeout(Math.min(1000, this.requestTimeoutMs)));
      this.notify("exit", {});
    } catch {
      // the server may already be gone
    }
    await this.transport.close();
    this.transport = undefined;
    this.initialized = false;
  }

  private renameTool(applyEdit: (filePath: string, edit: unknown, signal?: AbortSignal) => Promise<ToolOutput>): AgentTool {
    return {
      name: "lsp_rename",
      description:
        "Rename a symbol across the workspace with the language server. Positions are 1-based line and column, matching read_file anchors.",
      parameters: z.object({
        filePath: z.string().min(1),
        line: z.number().int().positive(),
        column: z.number().int().positive(),
        newName: z.string().min(1),
      }),
      readOnly: false,
      execute: async (args, context) => {
        const typed = args as { filePath: string; line: number; column: number; newName: string };
        const edit = await this.request("textDocument/rename", {
          textDocument: { uri: pathToFileURL(typed.filePath).href },
          position: { line: typed.line - 1, character: typed.column - 1 }, newName: typed.newName,
        }, context?.signal);
        if (edit === null) return { status: "empty", text: "rename produced no edits", sources: [{ uri: "lsp:textDocument/rename", title: "Language server" }] };
        return applyEdit(typed.filePath, parseWorkspaceEdit(edit), context?.signal);
      },
    };
  }

  private definitionTool(): AgentTool {
    return {
      name: "lsp_definition",
      description: "Jump to the definition of the symbol at a 1-based line and column position.",
      parameters: z.object({
        filePath: z.string().min(1),
        line: z.number().int().positive(),
        column: z.number().int().positive(),
      }),
      readOnly: true,
      concurrency: "shared",
      execute: async (args, context) => {
        const typed = args as { filePath: string; line: number; column: number };
        const locations = await this.definition(typed.filePath, typed.line, typed.column, context?.signal);
        return { status: locations.length ? "success" : "empty", text: locations.length > 0 ? locations.join("\n") : "Language server returned no definition.", sources: [{ uri: "lsp:textDocument/definition", title: "Language server" }] };
      },
    };
  }

  private referencesTool(): AgentTool {
    return {
      name: "lsp_references",
      description: "Find references to the symbol at a 1-based line and column position.",
      parameters: z.object({
        filePath: z.string().min(1),
        line: z.number().int().positive(),
        column: z.number().int().positive(),
        includeDeclaration: z.boolean().default(true),
      }),
      readOnly: true,
      concurrency: "shared",
      execute: async (args, context) => {
        const typed = args as {
          filePath: string;
          line: number;
          column: number;
          includeDeclaration: boolean;
        };
        const locations = await this.references(
          typed.filePath,
          typed.line,
          typed.column,
          typed.includeDeclaration, context?.signal,
        );
        return { status: locations.length ? "success" : "empty", text: locations.length > 0 ? locations.join("\n") : "Language server returned no references.", sources: [{ uri: "lsp:textDocument/references", title: "Language server" }] };
      },
    };
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new LspFailure("cancelled", method, `Language server request cancelled: ${method}`));
    let transport: StdioFramedTransport;
    try {
      transport = this.assertReady();
      if (method !== "initialize" && method !== "shutdown" && !this.initialized) throw new LspFailure("not_ready", method, "Language server is not initialized.");
    } catch (error) { return Promise.reject(lspFailure(error, method, signal)); }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending.delete(id); };
      const cancel = (error: Error) => {
        cleanup();
        try { transport.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }); } catch { /* Server may have exited. */ }
        reject(error);
      };
      const abort = () => cancel(new LspFailure("cancelled", method, `Language server request cancelled: ${method}`));
      const timer = setTimeout(() => cancel(new LspFailure("timeout", method, `Language server request timed out after ${this.requestTimeoutMs}ms: ${method}`)), this.requestTimeoutMs);
      this.pending.set(id, { resolve: (value) => { cleanup(); resolve(value); }, reject: (error) => { cleanup(); reject(error instanceof LspFailure ? new LspFailure(error.kind, method, error.message) : lspFailure(error, method, signal)); } });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { transport.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { cleanup(); reject(new LspFailure("server_exited", method, error instanceof Error ? error.message : String(error))); }
    });
  }

  private notify(method: string, params: unknown): void {
    this.assertReady().send({ jsonrpc: "2.0", method, params });
  }

  private assertReady(): StdioFramedTransport {
    if (!this.transport) throw new LspFailure("not_ready", "transport", "call initialize() before using the language client");
    if (!this.transport.isOpen()) throw new LspFailure("server_exited", "transport", "Language server is no longer running.");
    return this.transport;
  }

  private handleMessage(raw: unknown): void {
    const message = raw as {
      id?: number;
      result?: unknown;
      error?: { message?: string; code?: number };
      method?: string;
      params?: unknown;
    };
    if (typeof message.id === "number") {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new LspFailure(message.error.code === -32601 ? "unsupported" : message.error.code === -32800 ? "cancelled" : "protocol_error", "response", message.error.message ?? "language server request failed"));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri: string; diagnostics: RawDiagnostic[] };
      const mapped = (params.diagnostics ?? []).map((item) => toDiagnostic(params.uri, item));
      this.latestDiagnostics.set(params.uri, mapped);
      const waiters = this.diagnosticWaiters.get(params.uri) ?? [];
      this.diagnosticWaiters.delete(params.uri);
      for (const waiter of waiters) waiter.resolve(mapped);
    }
  }

  private awaitDiagnostics(uri: string, signal?: AbortSignal): Promise<LSPDiagnostic[]> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const remaining = (this.diagnosticWaiters.get(uri) ?? []).filter((entry) => entry !== waiter);
        if (remaining.length) this.diagnosticWaiters.set(uri, remaining); else this.diagnosticWaiters.delete(uri);
      };
      const waiter = { resolve: (diagnostics: LSPDiagnostic[]) => { cleanup(); resolve(diagnostics); }, reject: (error: Error) => { cleanup(); reject(error); } };
      const abort = () => waiter.reject(new LspFailure("cancelled", "diagnostics", "Language server diagnostics cancelled."));
      const timer = setTimeout(() => waiter.reject(new LspFailure("timeout", "diagnostics", `No language-server diagnostic publication arrived within ${this.diagnosticTimeoutMs}ms.`)), this.diagnosticTimeoutMs);
      const waiters = this.diagnosticWaiters.get(uri) ?? [];
      waiters.push(waiter); this.diagnosticWaiters.set(uri, waiters);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

}

function toDiagnostic(uri: string, raw: RawDiagnostic): LSPDiagnostic {
  return {
    file: uri.startsWith("file:") ? fileURLToPath(uri) : uri,
    line: raw.range.start.line + 1,
    column: raw.range.start.character + 1,
    severity: SEVERITIES[(raw.severity ?? 1) - 1] ?? "error",
    message: raw.message,
    ...(raw.code !== undefined ? { code: String(raw.code) } : {}),
    ...(raw.source ? { source: raw.source } : {}),
  };
}

function formatLocations(raw: unknown): string[] {
  if (raw === null) return [];
  const location = z.union([z.object({ uri: z.string().min(1), range: RawRangeSchema }), z.object({ targetUri: z.string().min(1), targetSelectionRange: RawRangeSchema })]);
  const parsed = z.union([location, z.array(location)]).safeParse(raw);
  if (!parsed.success) throw new LspFailure("invalid_response", "navigation", "Language server returned invalid navigation locations.");
  const entries = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  return entries.map((entry) => {
    const uri = "uri" in entry ? entry.uri : entry.targetUri;
    const range = "range" in entry ? entry.range : entry.targetSelectionRange;
    return `${uri.startsWith("file:") ? fileURLToPath(uri) : uri}:${range.start.line + 1}:${range.start.character + 1}`;
  });
}

function collectWorkspaceEdits(edit: WorkspaceEdit): Map<string, LSPTextEdit[]> {
  const out = new Map<string, LSPTextEdit[]>();
  const add = (uri: string, edits: LSPTextEdit[]): void => {
    const file = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
    out.set(file, [...(out.get(file) ?? []), ...edits]);
  };
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(uri, edits);
  for (const change of edit.documentChanges ?? []) {
    if (change.textDocument?.uri && change.edits) add(change.textDocument.uri, change.edits);
  }
  return out;
}

function applyTextEdits(content: string, edits: LSPTextEdit[]): string {
  const offsets = lineOffsets(content);
  const positioned = edits
    .map((edit) => ({
      edit,
      start: toOffset(offsets, edit.range.start),
      end: toOffset(offsets, edit.range.end),
    }))
    .sort((left, right) => right.start - left.start);
  let result = content;
  for (const { edit, start, end } of positioned) {
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}

function lineOffsets(content: string): number[] {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") offsets.push(index + 1);
  }
  return offsets;
}

function toOffset(offsets: number[], position: { line: number; character: number }): number {
  const base = offsets[position.line] ?? offsets[offsets.length - 1] ?? 0;
  return base + position.character;
}

function languageIdFor(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  switch (extension) {
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "typescriptreact";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "javascriptreact";
    case "py":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    default:
      return "plaintext";
  }
}

const RawPositionSchema = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() });
const RawRangeSchema = z.object({ start: RawPositionSchema, end: RawPositionSchema });
const MarkedStringSchema = z.union([z.string(), z.object({ value: z.string(), language: z.string().optional(), kind: z.string().optional() })]);

function formatHover(raw: unknown): string | null {
  if (raw === null) return null;
  const parsed = z.object({ contents: z.union([MarkedStringSchema, z.array(MarkedStringSchema)]) }).safeParse(raw);
  if (!parsed.success) throw new LspFailure("invalid_response", "textDocument/hover", "Language server returned an invalid hover response.");
  const format = (part: z.infer<typeof MarkedStringSchema>) => typeof part === "string" ? part : part.language ? `\`\`\`${part.language}\n${part.value}\n\`\`\`` : part.value;
  const text = Array.isArray(parsed.data.contents) ? parsed.data.contents.map(format).join("\n\n") : format(parsed.data.contents);
  return text.trim() ? text : null;
}

const LSP_SYMBOL_KINDS: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum-member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type-parameter",
};

function formatWorkspaceSymbols(raw: unknown): LSPWorkspaceSymbol[] {
  if (raw === null) return [];
  const parsed = z.array(z.object({ name: z.string().min(1), kind: z.number().int(), containerName: z.string().optional(), location: z.object({ uri: z.string().min(1), range: RawRangeSchema.optional() }) })).safeParse(raw);
  if (!parsed.success) throw new LspFailure("invalid_response", "workspace/symbol", "Language server returned an invalid workspace symbol response.");
  return parsed.data.map((entry) => {
    const uri = entry.location.uri;
    return {
      name: entry.name, kind: LSP_SYMBOL_KINDS[entry.kind] ?? "symbol", containerName: entry.containerName, uri,
      file: uri.startsWith("file:") ? fileURLToPath(uri) : uri,
      ...(entry.location.range ? { line: entry.location.range.start.line + 1, column: entry.location.range.start.character + 1 } : {}),
    };
  });
}
