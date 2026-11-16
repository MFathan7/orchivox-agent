import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

import type { LSPClient, LSPDiagnostic } from "./lsp-client";
import { formatLine, readText, splitLines } from "../tools/hashline-edit";
import type { AgentTool } from "../tools/registry";
import { workspaceRoot } from "../tools/workspace";
import { pathToFileURL } from "node:url";
import { runToolProcess, ToolProcessTimeoutError } from "../tools/process";
import { ToolResultError } from "../tools/result";
import { lspFailure } from "./lsp-status";
import type { ToolOutput } from "../types/schema";

export { type LSPDiagnostic } from "./lsp-client";

export function parseTscOutput(
  rawOutput: string,
  repoRoot: string = globalThis.process.cwd(),
  targetFile?: string,
): LSPDiagnostic[] {
  const diagnostics: LSPDiagnostic[] = [];
  const lines = rawOutput.split("\n");
  const pattern = /^(.+?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))\s*[:-]\s*(error|warning)\s*([A-Za-z0-9_-]+)?:\s*(.+)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = pattern.exec(trimmed);
    if (!match) continue;

    const rawFile = match[1];
    const lineNum = Number(match[2] ?? match[4]);
    const colNum = Number(match[3] ?? match[5]);
    const severity = match[6].toLowerCase() as "error" | "warning";
    const code = match[7];
    const message = match[8];

    if (targetFile && resolve(repoRoot, rawFile.replace(/\\/g, "/")) !== resolve(repoRoot, targetFile.replace(/\\/g, "/"))) continue;

    const relFile = isAbsolute(rawFile) ? relative(repoRoot, rawFile) : rawFile;

    diagnostics.push({
      file: relFile,
      line: lineNum,
      column: colNum,
      severity,
      message,
      code,
      source: "tsc",
    });
  }

  return diagnostics;
}

export async function runTscDiagnostics(
  repoRoot: string = globalThis.process.cwd(),
  targetFile?: string,
  signal?: AbortSignal,
): Promise<LSPDiagnostic[]> {
  const sources = [{ uri: `${pathToFileURL(repoRoot).href}#typecheck`, title: "Configured typecheck command" }];
  let result;
  try { result = await runToolProcess(["bun", "run", "typecheck"], { cwd: repoRoot, signal }); }
  catch (error) {
    throw new ToolResultError({ status: signal?.aborted ? "cancelled" : "error", code: signal?.aborted ? "aborted" : error instanceof ToolProcessTimeoutError ? "typecheck_timeout" : "typecheck_failed", text: error instanceof Error ? error.message : String(error), sources });
  }
  const output = `${result.output}\n${result.error}`;
  const all = parseTscOutput(output, repoRoot);
  const diagnostics = targetFile ? parseTscOutput(output, repoRoot, targetFile) : all;
  if (result.truncated || (result.code !== 0 && diagnostics.length === 0)) {
    throw new ToolResultError({
      status: result.truncated || all.length ? "partial" : "error", code: result.truncated ? "typecheck_output_limit" : "typecheck_failed",
      text: output, reason: `Typecheck exited with code ${result.code}.${result.truncated ? " Output was truncated." : ""} No clean result can be inferred for the requested scope.`,
      data: JSON.parse(JSON.stringify({ source: "typecheck", diagnostics, exitCode: result.code })), sources,
      coverage: { scope: targetFile ? `Configured typecheck, filtered to ${targetFile}` : "Configured typecheck output", complete: false },
    });
  }
  return diagnostics;
}

export async function formatDiagnosticWithHashlines(
  diag: LSPDiagnostic,
  repoRoot: string = globalThis.process.cwd(),
  contextRadius = 3,
): Promise<string> {
  const fullPath = isAbsolute(diag.file) ? diag.file : resolve(repoRoot, diag.file);
  let snippet = "";

  try {
    const content = await readText(fullPath);
    const lines = splitLines(content);
    const startLine = Math.max(1, diag.line - contextRadius);
    const endLine = Math.min(lines.length, diag.line + contextRadius);

    const formattedLines: string[] = [];
    for (let l = startLine; l <= endLine; l += 1) {
      const formatted = formatLine(l, lines[l - 1] ?? "");
      if (l === diag.line) {
        formattedLines.push(`--> ${formatted}`);
      } else {
        formattedLines.push(`    ${formatted}`);
      }
    }
    snippet = formattedLines.join("\n");
  } catch {
    snippet = "    (unable to read source file lines)";
  }

  const prefix = diag.severity.toUpperCase();
  const codeTag = diag.code ? ` [${diag.code}]` : "";
  return [
    `[${prefix}] ${diag.file}:${diag.line}:${diag.column}${codeTag} - ${diag.message}`,
    "Hashline anchors (use directly with hash_edit):",
    snippet,
  ].join("\n");
}

export async function formatDiagnosticsReport(
  diagnostics: LSPDiagnostic[],
  repoRoot: string = globalThis.process.cwd(),
): Promise<string> {
  if (diagnostics.length === 0) {
    return "Diagnostics clean: 0 errors/warnings found.";
  }

  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  const formattedItems = await Promise.all(
    diagnostics.map((diag) => formatDiagnosticWithHashlines(diag, repoRoot, 3)),
  );

  return [
    `Found ${diagnostics.length} diagnostic(s) (${errors.length} errors, ${warnings.length} warnings):`,
    "",
    formattedItems.join("\n\n"),
  ].join("\n");
}

export async function buildSelfHealingPrompt(
  filePath: string,
  diagnostics: LSPDiagnostic[],
  repoRoot: string = globalThis.process.cwd(),
): Promise<string> {
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length === 0) return "";

  const formattedItems = await Promise.all(
    errors.map((diag) => formatDiagnosticWithHashlines(diag, repoRoot, 3)),
  );

  return [
    "",
    "[LSP COMPILER ERROR DETECTED AFTER EDIT]",
    `Your recent modification to ${filePath} introduced ${errors.length} compiler error(s):`,
    "",
    formattedItems.join("\n\n"),
    "",
    "CRITICAL: Fix these compiler errors immediately using hash_edit before continuing or declaring the task complete.",
  ].join("\n");
}

export class WorkspaceDiagnosticsRunner {
  private readonly lsp: LSPClient | undefined;
  private readonly repoRoot: string;

  constructor(options?: { lsp?: LSPClient; repoRoot?: string }) {
    this.lsp = options?.lsp;
    this.repoRoot = options?.repoRoot ?? globalThis.process.cwd();
  }

  async runReport(options?: { filePath?: string; runTsc?: boolean; signal?: AbortSignal }): Promise<ToolOutput> {
    const targetFile = options?.filePath, signal = options?.signal;
    signal?.throwIfAborted();
    let compilerFailure: ToolOutput | undefined;
    if (options?.runTsc ?? true) {
      try {
        const diagnostics = await runTscDiagnostics(this.repoRoot, targetFile, signal);
        return { status: diagnostics.length ? "success" : "empty", text: diagnostics.length ? await formatDiagnosticsReport(diagnostics, this.repoRoot) : "Configured typecheck completed without reported file diagnostics for the requested scope.",
          data: JSON.parse(JSON.stringify({ source: "typecheck", diagnostics })), sources: [{ uri: `${pathToFileURL(this.repoRoot).href}#typecheck`, title: "Configured typecheck command" }],
          coverage: { scope: targetFile ? `File diagnostics parsed from typecheck: ${targetFile}` : "File-located diagnostics parsed from configured typecheck", complete: false } };
      } catch (error) {
        signal?.throwIfAborted();
        compilerFailure = error instanceof ToolResultError ? error.output : { status: "error", text: error instanceof Error ? error.message : String(error) };
        if (compilerFailure.status === "cancelled") throw new ToolResultError(compilerFailure);
        if (compilerFailure.status === "partial") return compilerFailure;
      }
    }
    if (this.lsp && targetFile) {
      const fullPath = resolve(this.repoRoot, targetFile);
      let content: string;
      try { content = await readText(fullPath); }
      catch (error) {
        signal?.throwIfAborted();
        throw new ToolResultError({ status: "error", code: "local_read_failed", text: error instanceof Error ? error.message : String(error), sources: [{ uri: pathToFileURL(fullPath).href, title: "Local diagnostic input" }] });
      }
      try {
        const diagnostics = await this.lsp.notifyFileChanged(fullPath, content, signal);
        signal?.throwIfAborted();
        return { status: compilerFailure ? "partial" : diagnostics.length ? "success" : "empty", text: diagnostics.length ? await formatDiagnosticsReport(diagnostics, this.repoRoot) : `Language server published no diagnostics for this file.${compilerFailure ? " The compiler check did not complete." : ""}`,
          ...(compilerFailure ? { reason: `Compiler check failed; showing a file-scoped LSP diagnostic publication only. ${compilerFailure.reason ?? compilerFailure.text ?? ""}` } : {}),
          data: JSON.parse(JSON.stringify({ source: "lsp", diagnostics, ...(compilerFailure ? { compilerFailure } : {}) })),
          coverage: { scope: `Language-server publication for ${targetFile}; other files are not covered.`, complete: !compilerFailure },
          sources: [{ uri: pathToFileURL(fullPath).href, title: "Language-server file diagnostics" }] };
      } catch (error) {
        const failure = lspFailure(error, "diagnostics", signal);
        if (!compilerFailure || failure.kind === "cancelled") throw failure;
        throw new ToolResultError({ ...failure.output,
          reason: `Compiler check failed and LSP diagnostics were unavailable. ${failure.message}`,
          data: JSON.parse(JSON.stringify({ source: "lsp", compilerFailure, lspFailure: { code: failure.output.code, reason: failure.message } })),
        });
      }
    }
    return compilerFailure ?? { status: "unavailable", code: "diagnostics_unavailable", text: "No diagnostic backend is available for this scope. Enable the configured typecheck or attach an LSP server and select a file." };
  }

  async runDiagnostics(options?: { filePath?: string; runTsc?: boolean; signal?: AbortSignal }): Promise<LSPDiagnostic[]> {
    const report = await this.runReport(options);
    if (!["success", "empty"].includes(report.status)) throw new ToolResultError(report);
    return (report.data as unknown as { diagnostics: LSPDiagnostic[] }).diagnostics;
  }

  async runAndFormat(filePath?: string, runTsc?: boolean): Promise<string> {
    const report = await this.runReport({ filePath, runTsc });
    if (!["success", "empty"].includes(report.status)) throw new ToolResultError(report);
    return report.text ?? "";
  }

}

export const DiagnosticsCheckArgsSchema = z.object({
  filePath: z.string().optional(),
  runTsc: z.boolean().default(true),
});
export type DiagnosticsCheckArgs = z.infer<typeof DiagnosticsCheckArgsSchema>;

export function createDiagnosticsCheckTool(options?: {
  lsp?: LSPClient;
  repoRoot?: string;
}): AgentTool<typeof DiagnosticsCheckArgsSchema> {
  const repoRoot = options?.repoRoot ?? globalThis.process.cwd();
  const runner = new WorkspaceDiagnosticsRunner({ lsp: options?.lsp, repoRoot });

  return {
    name: "diagnostics_check",
    description:
      "Inspect LSP and compiler typecheck diagnostics across the workspace or for a specific file. Returns all errors formatted with hashline code snippets (line:hash| code) so they can be immediately fixed using hash_edit.",
    parameters: DiagnosticsCheckArgsSchema,
    readOnly: true,
    concurrency: "shared",
    async execute(args, context) {
      const root = workspaceRoot(repoRoot);
      if (root === repoRoot) return runner.runReport({ filePath: args.filePath, runTsc: args.runTsc, signal: context?.signal });
      // A worker worktree has its own tsconfig and no LSP session of its own.
      const workerRunner = new WorkspaceDiagnosticsRunner({ repoRoot: root });
      return workerRunner.runReport({ filePath: args.filePath, runTsc: args.runTsc, signal: context?.signal });
    },
  };
}
