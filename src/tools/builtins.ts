import { createTwoFilesPatch } from "diff";
import { stat } from "node:fs/promises";
import { z } from "zod";

import { formatLine, readText, splitLines } from "./hashline-edit";
import { truncateHead, DEFAULT_MAX_BYTES } from "./output-budget";
import type { AgentTool } from "./registry";

interface IgnoreRule {
  negate: boolean;
  dirOnly: boolean;
  anchored: boolean;
  glob: Bun.Glob;
}

function parseIgnoreRules(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/") || line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    rules.push({ negate, dirOnly, anchored, glob: new Bun.Glob(line) });
  }
  return rules;
}

const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  "__pycache__",
  "target",
  "vendor",
]);

function isIgnored(relativePath: string, rules: IgnoreRule[]): boolean {
  if (relativePath === ".git" || relativePath.startsWith(".git/")) return true;
  const segments = relativePath.split("/");
  if (segments.some((segment) => DEFAULT_IGNORED_DIRS.has(segment))) return true;
  let ignored = false;
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const prefix = segments.slice(0, depth).join("/");
    const base = segments[depth - 1];
    const isFileSegment = depth === segments.length;
    for (const rule of rules) {
      if (rule.dirOnly && isFileSegment) continue;
      if (rule.glob.match(prefix) || (!rule.anchored && rule.glob.match(base))) ignored = !rule.negate;
    }
  }
  return ignored;
}

async function loadIgnoreRules(basePath: string): Promise<IgnoreRule[]> {
  const file = Bun.file(`${basePath}/.gitignore`);
  if (!(await file.exists())) return [];
  return parseIgnoreRules(await file.text());
}

export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;
export const DEFAULT_GLOB_LIMIT = 100;
export const DEFAULT_GREP_LIMIT = 100;

export interface CollectFilesResult {
  files: string[];
  timedOut: boolean;
}

export async function collectFilesWithStatus(
  basePath: string,
  include: string | undefined,
  maxFiles: number,
  timeoutMs: number = DEFAULT_SEARCH_TIMEOUT_MS,
): Promise<CollectFilesResult> {
  if (timeoutMs <= 0) return { files: [], timedOut: true };
  const deadline = Date.now() + timeoutMs;
  const rules = await loadIgnoreRules(basePath);
  const glob = new Bun.Glob(include ?? "**/*");
  const collected: string[] = [];
  for await (const relative of glob.scan({ cwd: basePath, onlyFiles: true })) {
    if (Date.now() > deadline) return { files: collected.sort(), timedOut: true };
    if (isIgnored(relative, rules)) continue;
    collected.push(relative);
    if (collected.length >= maxFiles) break;
  }
  return { files: collected.sort(), timedOut: false };
}

export async function collectFiles(
  basePath: string,
  include: string | undefined,
  maxFiles: number,
): Promise<string[]> {
  // Existing callers such as the AST map keep their old unbounded behavior.
  const result = await collectFilesWithStatus(
    basePath,
    include,
    maxFiles,
    Number.MAX_SAFE_INTEGER,
  );
  return result.files;
}

export const GlobFilesArgsSchema = z.object({
  pattern: z.string().min(1),
  basePath: z.string().default("."),
  maxResults: z.number().int().positive().default(DEFAULT_GLOB_LIMIT),
});
export type GlobFilesArgs = z.infer<typeof GlobFilesArgsSchema>;

export function createGlobFilesTool(
  options: { maxResults?: number; timeoutMs?: number } = {},
): AgentTool<typeof GlobFilesArgsSchema> {
  const limit = options.maxResults ?? DEFAULT_GLOB_LIMIT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  return {
    name: "glob_files",
    description:
      "List files matching a glob pattern such as src/**/*.ts. The .gitignore in the base path is honored.",
    parameters: GlobFilesArgsSchema,
    readOnly: true,
    async execute(args) {
      const maxResults = Math.min(args.maxResults, limit);
      const result = await collectFilesWithStatus(
        args.basePath,
        args.pattern,
        maxResults,
        timeoutMs,
      );
      if (result.files.length === 0) {
        return result.timedOut
          ? `search timed out after ${Math.round(timeoutMs / 1000)}s before any file matched; narrow the pattern or base path.`
          : `no files matched "${args.pattern}"`;
      }
      const body = truncateHead(result.files.join("\n")).text;
      return result.timedOut
        ? `${body}\n[Search timed out after ${Math.round(timeoutMs / 1000)}s; showing partial results. Narrow the pattern or base path.]`
        : body;
    },
  };
}

export const GrepSearchArgsSchema = z.object({
  pattern: z.string().min(1),
  basePath: z.string().default("."),
  include: z.string().optional(),
  maxResults: z.number().int().positive().default(DEFAULT_GREP_LIMIT),
});
export type GrepSearchArgs = z.infer<typeof GrepSearchArgsSchema>;

export function createGrepSearchTool(
  options: { maxResults?: number; timeoutMs?: number; maxFiles?: number } = {},
): AgentTool<typeof GrepSearchArgsSchema> {
  const limit = options.maxResults ?? DEFAULT_GREP_LIMIT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  const maxFiles = options.maxFiles ?? 5000;
  return {
    name: "grep_search",
    description:
      "Search a regex across files in parallel. Each match prints path:line:hash| text, and the line:hash part is a valid anchor for hash_edit.",
    parameters: GrepSearchArgsSchema,
    readOnly: true,
    async execute(args) {
      let regex: RegExp;
      try {
        regex = new RegExp(args.pattern);
      } catch (error) {
        throw new Error(`invalid regex: ${error instanceof Error ? error.message : String(error)}`);
      }

      const deadline = Date.now() + timeoutMs;
      const scanned = await collectFilesWithStatus(
        args.basePath,
        args.include,
        maxFiles,
        timeoutMs,
      );
      const files = scanned.files;
      let timedOut = scanned.timedOut;
      const perFile: string[][] = [];
      const chunkSize = 32;
      for (let offset = 0; offset < files.length; offset += chunkSize) {
        if (timedOut || Date.now() > deadline) {
          timedOut = true;
          break;
        }
        const chunk = files.slice(offset, offset + chunkSize);
        const results = await Promise.all(
          chunk.map(async (relative) => {
            const fullPath = `${args.basePath}/${relative}`;
            const info = await stat(fullPath).catch(() => undefined);
            if (!info || !info.isFile() || info.size > 2_000_000) return [];
            const text = await readText(fullPath);
            if (text.includes("\u0000")) return [];
            const hits: string[] = [];
            for (const [index, line] of splitLines(text).entries()) {
              if (regex.test(line)) hits.push(`${relative}:${formatLine(index + 1, line)}`);
            }
            return hits;
          }),
        );
        perFile.push(...results);
        if (Date.now() > deadline) timedOut = true;
        // Keep the event loop responsive while a wide search walks a repository.
        await new Promise((resolve) => setImmediate(resolve));
      }

      const matches = perFile.flat();
      const timeoutNote = timedOut
        ? `[Search timed out after ${Math.round(timeoutMs / 1000)}s; showing partial results. Narrow the pattern, include, or base path.]`
        : "";
      if (matches.length === 0) {
        return timedOut
          ? `no matches for /${args.pattern}/ before the search timed out after ${Math.round(timeoutMs / 1000)}s; narrow the pattern, include, or base path.`
          : `no matches for /${args.pattern}/`;
      }
      const maxResults = Math.min(args.maxResults, limit);
      const shown = matches.slice(0, maxResults);
      const truncated = matches.length - shown.length;
      const header = truncated > 0 ? `... ${truncated} more match(es) truncated` : "";
      const budget = truncateHead(shown.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      return [budget.text, header, timeoutNote].filter(Boolean).join("\n");
    },
  };
}

export const DiffViewArgsSchema = z.object({
  oldText: z.string(),
  newText: z.string(),
  oldLabel: z.string().default("old"),
  newLabel: z.string().default("new"),
  contextLines: z.number().int().min(0).max(20).default(3),
});
export type DiffViewArgs = z.infer<typeof DiffViewArgsSchema>;

export function createDiffViewTool(): AgentTool<typeof DiffViewArgsSchema> {
  return {
    name: "diff_view",
    description: "Build a unified diff from two texts, useful as a preview before hash_edit.",
    parameters: DiffViewArgsSchema,
    readOnly: true,
    execute(args) {
      if (args.oldText === args.newText) return "no differences";
      const patch = createTwoFilesPatch(
        args.oldLabel,
        args.newLabel,
        args.oldText,
        args.newText,
        undefined,
        undefined,
        { context: args.contextLines },
      );
      return patch.trim() === ""
        ? "no differences"
        : truncateHead(patch, { maxLines: Number.MAX_SAFE_INTEGER, maxBytes: DEFAULT_MAX_BYTES }).text;
    },
  };
}

export const JsonQueryArgsSchema = z
  .object({
    filePath: z.string().optional(),
    json: z.string().optional(),
    query: z.string().min(1),
  })
  .refine((value) => Boolean(value.filePath) !== Boolean(value.json), {
    message: "provide exactly one of filePath or json",
  });
export type JsonQueryArgs = z.infer<typeof JsonQueryArgsSchema>;

export function createJsonQueryTool(): AgentTool<typeof JsonQueryArgsSchema> {
  return {
    name: "json_query",
    description:
      "Evaluate a JSON path query like items[*].id or items[?(@.price < 10)].name against a JSON file or a JSON string. Queries are parsed and evaluated in memory, never executed as code.",
    parameters: JsonQueryArgsSchema,
    readOnly: true,
    async execute(args) {
      const source = args.filePath ? await readText(args.filePath) : (args.json ?? "");
      let data: unknown;
      try {
        data = JSON.parse(source);
      } catch (error) {
        throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      const result = evaluateJsonQuery(data, parseJsonQuery(args.query));
      return truncateHead(JSON.stringify(result ?? null, null, 2), {
        maxLines: Number.MAX_SAFE_INTEGER,
      }).text;
    },
  };
}

type FilterOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

type JsonSegment =
  | { kind: "key"; key: string }
  | { kind: "index"; index: number }
  | { kind: "wildcard" }
  | { kind: "filter"; field: string; op: FilterOp; value: unknown };

function parseJsonQuery(query: string): JsonSegment[] {
  const segments: JsonSegment[] = [];
  let index = 0;
  while (index < query.length) {
    const char = query[index];
    if (char === ".") {
      index += 1;
      continue;
    }
    if (char === "[") {
      const end = query.indexOf("]", index);
      if (end === -1) throw new Error(`unbalanced "[" in query: ${query}`);
      segments.push(parseBracket(query.slice(index + 1, end)));
      index = end + 1;
      continue;
    }
    let stop = index;
    while (stop < query.length && query[stop] !== "." && query[stop] !== "[") stop += 1;
    const key = query.slice(index, stop);
    if (key.length === 0) throw new Error(`empty path segment in query: ${query}`);
    segments.push({ kind: "key", key });
    index = stop;
  }
  return segments;
}

function parseBracket(inner: string): JsonSegment {
  if (inner === "*") return { kind: "wildcard" };
  if (/^\d+$/.test(inner)) return { kind: "index", index: Number(inner) };
  if (inner.startsWith("?(") && inner.endsWith(")")) return parseFilter(inner.slice(2, -1));
  throw new Error(`unsupported bracket expression: [${inner}]`);
}

function parseFilter(body: string): JsonSegment {
  const match = /^@\s*(\.[^\s]+)?\s*(==|!=|<=|>=|<|>)\s*(.+)$/.exec(body.trim());
  if (!match) throw new Error(`unsupported filter: ${body}`);
  const fieldPart = match[1];
  return {
    kind: "filter",
    field: fieldPart ? fieldPart.slice(1) : "",
    op: match[2] as FilterOp,
    value: parseLiteral(match[3].trim()),
  };
}

function parseLiteral(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function evaluateJsonQuery(data: unknown, segments: JsonSegment[]): unknown {
  let current: unknown[] = [data];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of current) {
      if (segment.kind === "key") {
        if (value && typeof value === "object" && !Array.isArray(value) && segment.key in value) {
          next.push((value as Record<string, unknown>)[segment.key]);
        }
      } else if (segment.kind === "index") {
        if (Array.isArray(value) && segment.index < value.length) next.push(value[segment.index]);
      } else if (segment.kind === "wildcard") {
        if (Array.isArray(value)) next.push(...value);
        else if (value && typeof value === "object") {
          next.push(...Object.values(value as Record<string, unknown>));
        }
      } else if (segment.kind === "filter") {
        if (Array.isArray(value)) {
          for (const item of value) if (matchesFilter(item, segment)) next.push(item);
        }
      }
    }
    current = next;
  }
  const multi = segments.some((segment) => segment.kind === "wildcard" || segment.kind === "filter");
  return multi ? current : (current[0] ?? null);
}

function matchesFilter(item: unknown, filter: { field: string; op: FilterOp; value: unknown }): boolean {
  const left = filter.field ? getField(item, filter.field) : item;
  switch (filter.op) {
    case "==":
      return left === filter.value;
    case "!=":
      return left !== filter.value;
    case "<":
      return compareValues(left, filter.value) < 0;
    case "<=":
      return compareValues(left, filter.value) <= 0;
    case ">":
      return compareValues(left, filter.value) > 0;
    case ">=":
      return compareValues(left, filter.value) >= 0;
  }
}

function getField(value: unknown, dottedPath: string): unknown {
  let current: unknown = value;
  for (const key of dottedPath.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a < b ? -1 : a > b ? 1 : 0;
}
