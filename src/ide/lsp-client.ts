import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

import type { AgentTool, ToolRegistry } from "../tools/registry";
import { StdioFramedTransport } from "./framing";

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
  line: number;
  column: number;
}

export interface LSPClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  diagnosticTimeoutMs?: number;
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
  private transport: StdioFramedTransport | undefined;
  private serverCapabilities: unknown;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly latestDiagnostics = new Map<string, LSPDiagnostic[]>();
  private readonly diagnosticWaiters = new Map<string, Array<(diagnostics: LSPDiagnostic[]) => void>>();
  private readonly openDocuments = new Set<string>();
  private readonly documentVersions = new Map<string, number>();

  constructor(options: LSPClientOptions) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.env = options.env;
    this.diagnosticTimeoutMs = options.diagnosticTimeoutMs ?? 250;
  }

  async initialize(workspaceRoot: string): Promise<void> {
    if (this.transport) throw new Error("language client is already initialized");
    this.transport = new StdioFramedTransport(this.command, this.args, { env: this.env });
    this.transport.onMessage((message) => this.handleMessage(message));

    const rootUri = pathToFileURL(workspaceRoot).toString();
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
        },
        workspace: { workspaceFolders: true },
      },
    })) as { capabilities?: unknown };
    this.serverCapabilities = result.capabilities ?? {};
    this.notify("initialized", {});
  }

  async notifyFileChanged(filePath: string, newContent: string): Promise<LSPDiagnostic[]> {
    const transport = this.assertReady();
    const uri = pathToFileURL(filePath).toString();
    const version = (this.documentVersions.get(uri) ?? 0) + 1;
    this.documentVersions.set(uri, version);
    const waiting = this.awaitDiagnostics(uri);

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
    return waiting;
  }

  async definition(filePath: string, line: number, column: number): Promise<string[]> {
    const result = await this.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(filePath).toString() },
      position: { line: line - 1, character: column - 1 },
    });
    return formatLocations(result);
  }

  async references(filePath: string, line: number, column: number, includeDeclaration = true): Promise<string[]> {
    const result = await this.request("textDocument/references", {
      textDocument: { uri: pathToFileURL(filePath).toString() },
      position: { line: line - 1, character: column - 1 },
      context: { includeDeclaration },
    });
    return formatLocations(result);
  }

  async rename(filePath: string, line: number, column: number, newName: string): Promise<string[]> {
    const result = (await this.request("textDocument/rename", {
      textDocument: { uri: pathToFileURL(filePath).toString() },
      position: { line: line - 1, character: column - 1 },
      newName,
    })) as WorkspaceEdit | null;
    if (!result) return [];
    const editsByFile = collectWorkspaceEdits(result);
    const changed: string[] = [];
    for (const [file, edits] of editsByFile) {
      const handle = Bun.file(file);
      const content = (await handle.exists()) ? await handle.text() : "";
      await Bun.write(file, applyTextEdits(content, edits));
      changed.push(file);
    }
    return changed;
  }

  isReady(): boolean {
    return Boolean(this.transport);
  }

  async hover(filePath: string, line: number, column: number): Promise<string | null> {
    if (!this.transport) return null;
    try {
      const result = await this.request("textDocument/hover", {
        textDocument: { uri: pathToFileURL(filePath).toString() },
        position: { line: line - 1, character: column - 1 },
      });
      return formatHover(result);
    } catch {
      return null;
    }
  }

  async workspaceSymbols(query: string): Promise<LSPWorkspaceSymbol[]> {
    if (!this.transport) return [];
    try {
      const result = await this.request("workspace/symbol", { query });
      return formatWorkspaceSymbols(result);
    } catch {
      return [];
    }
  }

  registerTools(registry: ToolRegistry): void {
    registry.register(this.renameTool());
    registry.register(this.definitionTool());
    registry.register(this.referencesTool());
  }

  async dispose(): Promise<void> {
    if (!this.transport) return;
    try {
      await this.request("shutdown", null);
      this.notify("exit", {});
    } catch {
      // the server may already be gone
    }
    await this.transport.close();
    this.transport = undefined;
  }

  private renameTool(): AgentTool {
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
      execute: async (args) => {
        const typed = args as { filePath: string; line: number; column: number; newName: string };
        const changed = await this.rename(typed.filePath, typed.line, typed.column, typed.newName);
        if (changed.length === 0) return "rename produced no edits";
        return `renamed to "${typed.newName}" in ${changed.length} file(s):\n${changed.join("\n")}`;
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
      execute: async (args) => {
        const typed = args as { filePath: string; line: number; column: number };
        const locations = await this.definition(typed.filePath, typed.line, typed.column);
        return locations.length > 0 ? locations.join("\n") : "no definition found";
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
      execute: async (args) => {
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
          typed.includeDeclaration,
        );
        return locations.length > 0 ? locations.join("\n") : "no references found";
      },
    };
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const transport = this.assertReady();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.assertReady().send({ jsonrpc: "2.0", method, params });
  }

  private assertReady(): StdioFramedTransport {
    if (!this.transport) throw new Error("call initialize() before using the language client");
    return this.transport;
  }

  private handleMessage(raw: unknown): void {
    const message = raw as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: unknown;
    };
    if (typeof message.id === "number") {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message ?? "language server request failed"));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri: string; diagnostics: RawDiagnostic[] };
      const mapped = (params.diagnostics ?? []).map((item) => toDiagnostic(params.uri, item));
      this.latestDiagnostics.set(params.uri, mapped);
      const waiters = this.diagnosticWaiters.get(params.uri) ?? [];
      this.diagnosticWaiters.delete(params.uri);
      for (const waiter of waiters) waiter(mapped);
    }
  }

  private awaitDiagnostics(uri: string): Promise<LSPDiagnostic[]> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const waiter = (diagnostics: LSPDiagnostic[]): void => {
        clearTimeout(timer);
        resolve(diagnostics);
      };
      timer = setTimeout(() => {
        const remaining = (this.diagnosticWaiters.get(uri) ?? []).filter((entry) => entry !== waiter);
        if (remaining.length > 0) this.diagnosticWaiters.set(uri, remaining);
        else this.diagnosticWaiters.delete(uri);
        resolve([]);
      }, this.diagnosticTimeoutMs);
      const waiters = this.diagnosticWaiters.get(uri) ?? [];
      waiters.push(waiter);
      this.diagnosticWaiters.set(uri, waiters);
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
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((item) => {
    const entry = item as { uri?: string; targetUri?: string; range?: RawRange; targetSelectionRange?: RawRange };
    const uri = entry.uri ?? entry.targetUri ?? "";
    const range = entry.range ?? entry.targetSelectionRange;
    const file = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
    return `${file}:${(range?.start.line ?? 0) + 1}:${(range?.start.character ?? 0) + 1}`;
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

function formatHover(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const hover = raw as { contents?: unknown };
  if (!hover.contents) return null;

  if (typeof hover.contents === "string") {
    return hover.contents;
  }
  if (Array.isArray(hover.contents)) {
    return hover.contents
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "value" in part) {
          const typed = part as { language?: string; value: string };
          return typed.language ? `\`\`\`${typed.language}\n${typed.value}\n\`\`\`` : typed.value;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof hover.contents === "object") {
    const obj = hover.contents as { kind?: string; value?: string; language?: string };
    if (obj.value) {
      return obj.language ? `\`\`\`${obj.language}\n${obj.value}\n\`\`\`` : obj.value;
    }
  }
  return null;
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
  if (!Array.isArray(raw)) return [];
  const results: LSPWorkspaceSymbol[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as {
      name?: string;
      kind?: number;
      containerName?: string;
      location?: {
        uri?: string;
        range?: RawRange;
      };
    };
    if (!entry.name || !entry.location?.uri) continue;
    const uri = entry.location.uri;
    const file = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
    const line = (entry.location.range?.start.line ?? 0) + 1;
    const column = (entry.location.range?.start.character ?? 0) + 1;
    const kind = (entry.kind && LSP_SYMBOL_KINDS[entry.kind]) || "symbol";
    results.push({
      name: entry.name,
      kind,
      containerName: entry.containerName,
      file,
      line,
      column,
    });
  }
  return results;
}
