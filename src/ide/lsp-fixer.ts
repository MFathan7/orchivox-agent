import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

import type { LSPClient, LSPDiagnostic } from "./lsp-client";
import { formatLine, readText, splitLines } from "../tools/hashline-edit";
import type { AgentTool } from "../tools/registry";
import { workspaceRoot } from "../tools/workspace";

export { type LSPDiagnostic } from "./lsp-client";

export function parseTscOutput(
  rawOutput: string,
  repoRoot: string = globalThis.process.cwd(),
  targetFile?: string,
): LSPDiagnostic[] {
  const diagnostics: LSPDiagnostic[] = [];
  const lines = rawOutput.split("\n");
  const pattern = /^([^\s()]+?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))\s*[:-]\s*(error|warning)\s*([A-Za-z0-9_-]+)?:\s*(.+)$/;

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

    const normalizedTarget = targetFile ? targetFile.replace(/\\/g, "/") : undefined;
    const normalizedFile = rawFile.replace(/\\/g, "/");

    if (normalizedTarget) {
      if (!normalizedFile.endsWith(normalizedTarget) && !normalizedTarget.endsWith(normalizedFile)) {
        continue;
      }
    }

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
): Promise<LSPDiagnostic[]> {
  try {
    const proc = Bun.spawn(["bun", "run", "typecheck"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    await proc.exited;
    const combinedOutput = `${stdout}\n${stderr}`;
    return parseTscOutput(combinedOutput, repoRoot, targetFile);
  } catch {
    return [];
  }
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

  async runDiagnostics(options?: { filePath?: string; runTsc?: boolean }): Promise<LSPDiagnostic[]> {
    const targetFile = options?.filePath;
    const shouldRunTsc = options?.runTsc ?? true;

    if (shouldRunTsc) {
      const tscResults = await runTscDiagnostics(this.repoRoot, targetFile);
      if (tscResults.length > 0 || !this.lsp) {
        return tscResults;
      }
    }

    if (this.lsp && targetFile) {
      try {
        const fullPath = isAbsolute(targetFile) ? targetFile : resolve(this.repoRoot, targetFile);
        const content = await readText(fullPath);
        return await this.lsp.notifyFileChanged(fullPath, content);
      } catch {
        return [];
      }
    }

    return [];
  }

  async runAndFormat(filePath?: string, runTsc?: boolean): Promise<string> {
    const diags = await this.runDiagnostics({ filePath, runTsc });
    return formatDiagnosticsReport(diags, this.repoRoot);
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
    async execute(args) {
      const root = workspaceRoot(repoRoot);
      if (root === repoRoot) return runner.runAndFormat(args.filePath, args.runTsc);
      // A worker worktree has its own tsconfig and no LSP session of its own.
      const workerRunner = new WorkspaceDiagnosticsRunner({ repoRoot: root });
      return workerRunner.runAndFormat(args.filePath, args.runTsc);
    },
  };
}
