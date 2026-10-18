import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applyPatch } from "diff";
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

export function parseAnchor(anchor: string): { line: number; hash: string } {
  const separator = anchor.indexOf(":");
  if (separator === -1) {
    throw new EditRejectedError(`invalid anchor format "${anchor}": must look like 14:a8f`);
  }
  return { line: Number(anchor.slice(0, separator)), hash: anchor.slice(separator + 1) };
}

export interface ResolvedAnchor {
  originalLine: number;
  resolvedLine: number;
  hash: string;
  recovered: boolean;
}

export function resolveAnchorWithFuzzyRecovery(
  anchor: string,
  lines: string[],
  windowSize = 15,
): ResolvedAnchor {
  const { line, hash } = parseAnchor(anchor);

  if (line >= 1 && line <= lines.length && computeLineHash(lines[line - 1]) === hash) {
    return { originalLine: line, resolvedLine: line, hash, recovered: false };
  }

  const minLine = Math.max(1, line - windowSize);
  const maxLine = Math.min(lines.length, line + windowSize);
  const candidates: number[] = [];

  for (let candidateLine = minLine; candidateLine <= maxLine; candidateLine += 1) {
    if (computeLineHash(lines[candidateLine - 1]) === hash) {
      candidates.push(candidateLine);
    }
  }

  if (candidates.length === 1) {
    return {
      originalLine: line,
      resolvedLine: candidates[0],
      hash,
      recovered: true,
    };
  }

  if (candidates.length > 1) {
    const sortedByDist = [...candidates].sort((a, b) => Math.abs(a - line) - Math.abs(b - line));
    const closestDist = Math.abs(sortedByDist[0] - line);
    const secondDist = Math.abs(sortedByDist[1] - line);

    if (closestDist < secondDist) {
      return {
        originalLine: line,
        resolvedLine: sortedByDist[0],
        hash,
        recovered: true,
      };
    }

    const snippetStart = Math.max(1, line - 5);
    const snippetEnd = Math.min(lines.length, line + 5);
    const snippet = lines
      .slice(snippetStart - 1, snippetEnd)
      .map((l, idx) => formatLine(snippetStart + idx, l))
      .join("\n");

    throw new EditRejectedError(
      `ambiguous anchor ${anchor}: found ${candidates.length} candidate lines in window [${minLine}-${maxLine}] (${candidates.join(", ")}):\n${snippet}`,
    );
  }

  const snippetStart = Math.max(1, line - 5);
  const snippetEnd = Math.min(lines.length, line + 5);
  const snippet = lines
    .slice(snippetStart - 1, snippetEnd)
    .map((l, idx) => formatLine(snippetStart + idx, l))
    .join("\n");

  throw new EditRejectedError(
    `anchor mismatch: ${anchor} not found in lines ${minLine}-${maxLine} (line ${line} has hash ${line <= lines.length ? computeLineHash(lines[line - 1]) : "EOF"}):\n${snippet}`,
  );
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

export const HashEditHunkSchema = z.object({
  startAnchor: z.string().regex(/^\d+:[0-9a-f]{3}$/, "anchor must look like 14:a8f"),
  endAnchor: z.string().regex(/^\d+:[0-9a-f]{3}$/, "anchor must look like 18:3c1"),
  newContent: z.string(),
});
export type HashEditHunk = z.infer<typeof HashEditHunkSchema>;

export const HashEditArgsSchema = z
  .object({
    filePath: z.string().min(1),
    startAnchor: z.string().regex(/^\d+:[0-9a-f]{3}$/, "anchor must look like 14:a8f").optional(),
    endAnchor: z.string().regex(/^\d+:[0-9a-f]{3}$/, "anchor must look like 18:3c1").optional(),
    newContent: z.string().optional(),
    edits: z.array(HashEditHunkSchema).optional(),
  })
  .refine(
    (data) => {
      const hasSingle =
        data.startAnchor !== undefined &&
        data.endAnchor !== undefined &&
        data.newContent !== undefined;
      const hasBatch = data.edits !== undefined && data.edits.length > 0;
      return hasSingle || hasBatch;
    },
    { message: "Either (startAnchor, endAnchor, newContent) or edits array must be provided" },
  );
export type HashEditArgs = z.infer<typeof HashEditArgsSchema>;

export function createHashEditTool(lifecycle: HashlineLifecycle = {}): AgentTool<typeof HashEditArgsSchema> {
  return {
    name: "hash_edit",
    description:
      "Replace one or more line ranges in a text file using hashline anchors (format 14:a8f). Supports both single-hunk replacement and batch multi-hunk replacements via the edits array. Hunks are automatically ordered bottom-to-top with fuzzy anchor recovery.",
    parameters: HashEditArgsSchema,
    readOnly: false,
    async execute(args) {
      const text = await readText(args.filePath);
      const trailingNewline = text.endsWith("\n");
      let lines = splitLines(text);

      const hunks: HashEditHunk[] =
        args.edits && args.edits.length > 0
          ? args.edits
          : [
              {
                startAnchor: args.startAnchor!,
                endAnchor: args.endAnchor!,
                newContent: args.newContent!,
              },
            ];

      interface ResolvedHunk {
        hunk: HashEditHunk;
        start: ResolvedAnchor;
        end: ResolvedAnchor;
      }

      const resolvedHunks: ResolvedHunk[] = [];

      for (const hunk of hunks) {
        const start = resolveAnchorWithFuzzyRecovery(hunk.startAnchor, lines, 15);
        const end = resolveAnchorWithFuzzyRecovery(hunk.endAnchor, lines, 15);

        if (end.resolvedLine < start.resolvedLine) {
          throw new EditRejectedError(
            `endAnchor (${hunk.endAnchor} -> line ${end.resolvedLine}) must not come before startAnchor (${hunk.startAnchor} -> line ${start.resolvedLine})`,
          );
        }

        resolvedHunks.push({ hunk, start, end });
      }

      resolvedHunks.sort((a, b) => b.start.resolvedLine - a.start.resolvedLine);

      for (let i = 0; i < resolvedHunks.length - 1; i += 1) {
        const lowerHunk = resolvedHunks[i];
        const upperHunk = resolvedHunks[i + 1];
        if (upperHunk.end.resolvedLine >= lowerHunk.start.resolvedLine) {
          throw new EditRejectedError(
            `overlapping edit hunks detected between lines ${upperHunk.start.resolvedLine}-${upperHunk.end.resolvedLine} and ${lowerHunk.start.resolvedLine}-${lowerHunk.end.resolvedLine}`,
          );
        }
      }

      const recoveredAnchors: string[] = [];
      const appliedDetails: string[] = [];

      for (const { hunk, start, end } of resolvedHunks) {
        if (start.recovered) recoveredAnchors.push(`${hunk.startAnchor}->line ${start.resolvedLine}`);
        if (end.recovered) recoveredAnchors.push(`${hunk.endAnchor}->line ${end.resolvedLine}`);

        const replacement = hunk.newContent === "" ? [] : splitLines(hunk.newContent);
        lines = [
          ...lines.slice(0, start.resolvedLine - 1),
          ...replacement,
          ...lines.slice(end.resolvedLine),
        ];
        appliedDetails.push(`lines ${start.resolvedLine}-${end.resolvedLine} -> ${replacement.length} line(s)`);
      }

      const nextText = lines.join("\n") + (trailingNewline && lines.length > 0 ? "\n" : "");

      await lifecycle.onBeforeModify?.(args.filePath);
      await Bun.write(args.filePath, nextText);
      await lifecycle.onAfterModify?.(args.filePath, nextText);

      const recoveryNote =
        recoveredAnchors.length > 0 ? ` (fuzzy recovered: ${recoveredAnchors.join(", ")})` : "";

      return `updated ${args.filePath}: applied ${resolvedHunks.length} hunk(s)${recoveryNote} (${appliedDetails.join("; ")}), file now has ${lines.length} line(s)`;
    },
  };
}

export const CreateFileArgsSchema = z.object({
  filePath: z.string().min(1),
  content: z.string(),
  overwrite: z.boolean().default(false),
});
export type CreateFileArgs = z.infer<typeof CreateFileArgsSchema>;

export function createCreateFileTool(lifecycle: HashlineLifecycle = {}): AgentTool<typeof CreateFileArgsSchema> {
  return {
    name: "create_file",
    description:
      "Create a new file with specified content. Creates any missing parent directories. Fails if the file exists unless overwrite is true.",
    parameters: CreateFileArgsSchema,
    readOnly: false,
    async execute(args) {
      const file = Bun.file(args.filePath);
      const exists = await file.exists();
      if (exists && !args.overwrite) {
        throw new EditRejectedError(
          `file already exists: ${args.filePath}. Set overwrite: true if you intend to replace it.`,
        );
      }

      await lifecycle.onBeforeModify?.(args.filePath);
      const parentDir = dirname(args.filePath);
      if (!existsSync(parentDir)) {
        await mkdir(parentDir, { recursive: true });
      }

      await Bun.write(args.filePath, args.content);
      await lifecycle.onAfterModify?.(args.filePath, args.content);
      const lineCount = splitLines(args.content).length;
      return `created ${args.filePath} with ${lineCount} line(s)`;
    },
  };
}

export const DeleteFileArgsSchema = z.object({
  filePath: z.string().min(1),
});
export type DeleteFileArgs = z.infer<typeof DeleteFileArgsSchema>;

export function createDeleteFileTool(lifecycle: HashlineLifecycle = {}): AgentTool<typeof DeleteFileArgsSchema> {
  return {
    name: "delete_file",
    description: "Delete an existing file from the filesystem.",
    parameters: DeleteFileArgsSchema,
    readOnly: false,
    async execute(args) {
      const file = Bun.file(args.filePath);
      if (!(await file.exists())) {
        throw new EditRejectedError(`file not found: ${args.filePath}`);
      }

      await lifecycle.onBeforeModify?.(args.filePath);
      await unlink(args.filePath);
      await lifecycle.onAfterModify?.(args.filePath, "");
      return `deleted ${args.filePath}`;
    },
  };
}

export const MoveFileArgsSchema = z.object({
  sourcePath: z.string().min(1),
  destinationPath: z.string().min(1),
  overwrite: z.boolean().default(false),
});
export type MoveFileArgs = z.infer<typeof MoveFileArgsSchema>;

export function createMoveFileTool(lifecycle: HashlineLifecycle = {}): AgentTool<typeof MoveFileArgsSchema> {
  return {
    name: "move_file",
    description:
      "Move or rename a file to a new destination path, creating any destination parent directories as needed.",
    parameters: MoveFileArgsSchema,
    readOnly: false,
    async execute(args) {
      const srcFile = Bun.file(args.sourcePath);
      if (!(await srcFile.exists())) {
        throw new EditRejectedError(`source file not found: ${args.sourcePath}`);
      }

      const destFile = Bun.file(args.destinationPath);
      if ((await destFile.exists()) && !args.overwrite) {
        throw new EditRejectedError(
          `destination file already exists: ${args.destinationPath}. Set overwrite: true if you intend to replace it.`,
        );
      }

      await lifecycle.onBeforeModify?.(args.sourcePath);
      await lifecycle.onBeforeModify?.(args.destinationPath);

      const destParent = dirname(args.destinationPath);
      if (!existsSync(destParent)) {
        await mkdir(destParent, { recursive: true });
      }

      const content = await srcFile.text();
      await Bun.write(args.destinationPath, content);
      await unlink(args.sourcePath);

      await lifecycle.onAfterModify?.(args.sourcePath, "");
      await lifecycle.onAfterModify?.(args.destinationPath, content);
      return `moved ${args.sourcePath} to ${args.destinationPath}`;
    },
  };
}

export const ApplyUnifiedPatchArgsSchema = z.object({
  filePath: z.string().min(1),
  patch: z.string().min(1),
});
export type ApplyUnifiedPatchArgs = z.infer<typeof ApplyUnifiedPatchArgsSchema>;

export function createApplyUnifiedPatchTool(
  lifecycle: HashlineLifecycle = {},
): AgentTool<typeof ApplyUnifiedPatchArgsSchema> {
  return {
    name: "apply_unified_patch",
    description: "Apply a standard unified diff / patch to an existing file.",
    parameters: ApplyUnifiedPatchArgsSchema,
    readOnly: false,
    async execute(args) {
      const file = Bun.file(args.filePath);
      if (!(await file.exists())) {
        throw new EditRejectedError(`file not found: ${args.filePath}`);
      }

      const oldText = await file.text();
      const patched = applyPatch(oldText, args.patch);
      if (patched === false) {
        throw new EditRejectedError(`failed to apply unified patch cleanly to ${args.filePath}`);
      }

      await lifecycle.onBeforeModify?.(args.filePath);
      await Bun.write(args.filePath, patched);
      await lifecycle.onAfterModify?.(args.filePath, patched);

      const oldLines = splitLines(oldText);
      const newLines = splitLines(patched);
      return `applied unified patch to ${args.filePath}: file changed from ${oldLines.length} to ${newLines.length} lines`;
    },
  };
}
