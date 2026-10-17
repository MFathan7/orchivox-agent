import { z } from "zod";

import type { AgentTool } from "./registry";

export interface HashlineLifecycle {
  onBeforeModify?: (filePath: string) => Promise<void> | void;
  onAfterModify?: (filePath: string, newContent: string) => Promise<void> | void;
}

export class EditRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditRejectedError";
  }
}

export function computeLineHash(line: string): string {
  return Bun.hash(line.trimEnd()).toString(16).padStart(16, "0").slice(-3);
}

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function formatLine(lineNumber: number, line: string): string {
  return `${lineNumber}:${computeLineHash(line)}| ${line}`;
}

export async function readText(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) throw new Error(`file not found: ${filePath}`);
  return file.text();
}

export const ReadFileArgsSchema = z.object({
  filePath: z.string().min(1),
  offset: z.number().int().positive().default(1),
  limit: z.number().int().positive().default(2000),
});
export type ReadFileArgs = z.infer<typeof ReadFileArgsSchema>;

export function createReadFileTool(): AgentTool<typeof ReadFileArgsSchema> {
  return {
    name: "read_file",
    description:
      "Read a text file as numbered lines with 3-hex line hashes (format 14:a8f| line). The number:hash part is a valid anchor for hash_edit.",
    parameters: ReadFileArgsSchema,
    readOnly: true,
    async execute(args) {
      const lines = splitLines(await readText(args.filePath));
      const slice = lines.slice(args.offset - 1, args.offset - 1 + args.limit);
      if (slice.length === 0) return `no lines to show: the file has ${lines.length} line(s)`;
      return slice.map((line, index) => formatLine(args.offset + index, line)).join("\n");
    },
  };
}

export const HashEditArgsSchema = z.object({
  filePath: z.string().min(1),
  startAnchor: z.string().regex(/^\d+:[0-9a-f]{3}$/, "anchor must look like 14:a8f"),
  endAnchor: z.string().regex(/^\d+:[0-9a-f]{3}$/, "anchor must look like 18:3c1"),
  newContent: z.string(),
});
export type HashEditArgs = z.infer<typeof HashEditArgsSchema>;

export function createHashEditTool(lifecycle: HashlineLifecycle = {}): AgentTool<typeof HashEditArgsSchema> {
  return {
    name: "hash_edit",
    description:
      "Replace the inclusive line range from startAnchor to endAnchor (14:a8f style) with newContent. When an anchor no longer matches the file, nothing is written and the answer carries the current lines with fresh hashes.",
    parameters: HashEditArgsSchema,
    readOnly: false,
    async execute(args) {
      const text = await readText(args.filePath);
      const trailingNewline = text.endsWith("\n");
      const lines = splitLines(text);
      const start = parseAnchor(args.startAnchor);
      const end = parseAnchor(args.endAnchor);
      if (end.line < start.line) throw new EditRejectedError("endAnchor must not come before startAnchor");

      const windowStart = Math.max(1, start.line - 5);
      const windowEnd = Math.min(lines.length, end.line + 5);
      const snapshot = (): string =>
        lines
          .slice(windowStart - 1, windowEnd)
          .map((line, index) => formatLine(windowStart + index, line))
          .join("\n");

      if (start.line > lines.length || end.line > lines.length) {
        throw new EditRejectedError(
          `anchors outside the file: it has ${lines.length} line(s)\n${snapshot()}`,
        );
      }

      const startHash = computeLineHash(lines[start.line - 1]);
      const endHash = computeLineHash(lines[end.line - 1]);
      if (startHash !== start.hash || endHash !== end.hash) {
        throw new EditRejectedError(
          `anchor mismatch: ${args.startAnchor} is now ${start.line}:${startHash}, ${args.endAnchor} is now ${end.line}:${endHash}\n${snapshot()}`,
        );
      }

      const replacement = args.newContent === "" ? [] : splitLines(args.newContent);
      const nextLines = [...lines.slice(0, start.line - 1), ...replacement, ...lines.slice(end.line)];
      const nextText = nextLines.join("\n") + (trailingNewline && nextLines.length > 0 ? "\n" : "");

      await lifecycle.onBeforeModify?.(args.filePath);
      await Bun.write(args.filePath, nextText);
      await lifecycle.onAfterModify?.(args.filePath, nextText);

      return `updated ${args.filePath}: replaced lines ${start.line}-${end.line} with ${replacement.length} line(s), file now has ${nextLines.length} line(s)`;
    },
  };
}

function parseAnchor(anchor: string): { line: number; hash: string } {
  const separator = anchor.indexOf(":");
  return { line: Number(anchor.slice(0, separator)), hash: anchor.slice(separator + 1) };
}
