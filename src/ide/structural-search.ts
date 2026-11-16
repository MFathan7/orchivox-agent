import { extname, join, resolve } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { collectFilesWithStatus } from "../tools/builtins";
import { readText, type HashlineLifecycle } from "../tools/hashline-edit";
import { truncateHead } from "../tools/output-budget";
import type { AgentTool, ToolRegistry } from "../tools/registry";
import { workspaceRoot } from "../tools/workspace";
import { AstBackends, type AstBackendOptions, type AstLanguage } from "./ast-backends";

const extensions: Record<string, AstLanguage> = { ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".pyi": "python", ".rs": "rust", ".go": "go" };
const Language = z.enum(["auto", "typescript", "javascript", "python", "rust", "go"]).default("auto");
function languageFor(file: string, requested: z.infer<typeof Language>): AstLanguage {
  const detected = extensions[extname(file).toLowerCase()];
  if (!detected || requested !== "auto" && requested !== detected) throw new Error(`Unsupported AST file/language combination: ${file} (${requested}). Use ast_search operation: capabilities.`);
  return detected;
}
const SearchSchema = z.object({
  operation: z.enum(["search", "capabilities"]).default("search"),
  language: Language,
  pattern: z.string().min(1).max(10_000).optional().describe("One syntax pattern for the selected language. $NAME captures a node; $$$NAME captures siblings."),
  filePath: z.string().optional(),
  basePath: z.string().default("."),
  include: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(30),
  maxFiles: z.number().int().min(1).max(300).default(100),
});
const EditSchema = z.object({
  language: Language,
  filePath: z.string().min(1), pattern: z.string().min(1).max(10_000),
  replacement: z.string().max(50_000).describe("Replacement code; captured $NAME and $$$NAME tokens are expanded."),
  expectedHash: z.string().min(1).describe("fileHash from a recent ast_search result; prevents edits against changed content."),
  expectedMatches: z.number().int().positive().max(100),
});
type Captures = Map<string, string>;
interface Match { start: number; end: number; line: number; column: number; captures: Captures }

function parse(source: string, file = "pattern.tsx"): ts.SourceFile {
  const kind = /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TSX;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) throw new Error(`Cannot parse ${file}: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " ")}`);
  return tree;
}

function capture(node: ts.Node): string | undefined {
  return ts.isIdentifier(node) && /^\${1,3}[A-Za-z_][\w]*$/.test(node.text) ? node.text : undefined;
}
function bind(captures: Captures, key: string, text: string): boolean {
  const previous = captures.get(key);
  if (previous !== undefined) return previous === text;
  captures.set(key, text);
  return true;
}
function equal(pattern: ts.Node, candidate: ts.Node, captures: Captures): boolean {
  const name = capture(pattern);
  if (name) return bind(captures, name, candidate.getText());
  if (pattern.kind !== candidate.kind) return false;
  const left = pattern.getChildren(), right = candidate.getChildren();
  if (!left.length) return pattern.getText() === candidate.getText();
  return sequence(left, right, captures);
}
function sequence(left: readonly ts.Node[], right: readonly ts.Node[], captures: Captures): boolean {
  const variadic = left.findIndex((node) => capture(node)?.startsWith("$$$"));
  if (variadic < 0) return left.length === right.length && left.every((node, index) => equal(node, right[index], captures));
  if (left.filter((node) => capture(node)?.startsWith("$$$")).length > 1) throw new Error("Use at most one variadic capture in a sibling list.");
  // A rest capture consumes separators with its sibling nodes, including an empty argument list.
  const prefix = left.slice(0, variadic), suffix = left.slice(variadic + 1);
  if (right.length < prefix.length + suffix.length) return false;
  if (!prefix.every((node, index) => equal(node, right[index], captures))) return false;
  const end = right.length - suffix.length;
  if (!suffix.every((node, index) => equal(node, right[end + index], captures))) return false;
  const middle = right.slice(prefix.length, end);
  const text = middle.length ? middle[0].getSourceFile().text.slice(middle[0].getStart(), middle[middle.length - 1].getEnd()) : "";
  return bind(captures, capture(left[variadic])!, text);
}

export function structuralMatches(source: string, patternText: string, filePath: string): Match[] {
  const sourceTree = parse(source, filePath), patternTree = parse(patternText);
  if (patternTree.statements.length !== 1) throw new Error("Use one expression or declaration as the pattern.");
  const statement = patternTree.statements[0];
  const pattern = ts.isExpressionStatement(statement) ? statement.expression : statement;
  const matches: Match[] = [];
  const visit = (node: ts.Node) => {
    const captures: Captures = new Map();
    if (equal(pattern, node, captures)) {
      const start = node.getStart(sourceTree), position = sourceTree.getLineAndCharacterOfPosition(start);
      matches.push({ start, end: node.getEnd(), line: position.line + 1, column: position.character + 1, captures });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceTree);
  return matches;
}
export const sourceHash = (source: string): string => new Bun.CryptoHasher("sha256").update(source).digest("hex");

export function createAstSearchTool(registry?: ToolRegistry, options: AstBackendOptions = {}): AgentTool<typeof SearchSchema> {
  const backends = new AstBackends(options);
  return {
    name: "ast_search", description: "Search syntax trees in TypeScript/JavaScript/Node.js, Python, Rust and Go. Python/Rust/Go require ast-grep on PATH; Python also requires Python 3.8+. Use operation: capabilities to inspect search/rewrite availability. $NAME captures a node; $$$NAME captures siblings. Set language to scope mixed repositories. Returns fileHash for supported guarded ast_edit; Rust/Go have search only.",
    parameters: SearchSchema, readOnly: true, concurrency: "shared",
    async execute(args, context) {
      if (args.operation === "capabilities") return JSON.stringify({ languages: backends.capabilities() });
      if (!args.pattern) throw new Error("pattern is required for AST search.");
      const pattern = args.pattern;
      if (args.filePath) languageFor(args.filePath, args.language);
      if (args.language === "typescript" || args.language === "javascript") structuralMatches("", pattern, "pattern.tsx");
      const base = workspaceRoot(process.cwd());
      const collected = args.filePath ? undefined : await collectFilesWithStatus(resolve(base, args.basePath), args.include, args.maxFiles, 5000, context?.signal);
      const paths = args.filePath ? [args.filePath] : collected!.files.map((path) => join(args.basePath, path));
      const results: unknown[] = [], skipped: string[] = [];
      let matched = 0;
      for (const path of paths) {
        context?.signal?.throwIfAborted();
        if (!extensions[extname(path).toLowerCase()] || args.language !== "auto" && extensions[extname(path).toLowerCase()] !== args.language) continue;
        const target = resolve(base, path);
        if (registry && !(await registry.authorize("read_file", { filePath: target }, context?.signal)).allowed) { skipped.push(`${path}: read denied`); continue; }
        const file = Bun.file(target);
        if (file.size > 1_000_000) { skipped.push(path); continue; }
        const source = await file.text();
        let matches: Match[];
        try {
          const language = languageFor(path, args.language);
          matches = language === "typescript" || language === "javascript" ? structuralMatches(source, pattern, path) : await backends.matches(source, pattern, language, context?.signal);
        }
        catch (error) { context?.signal?.throwIfAborted(); skipped.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); continue; }
        for (const match of matches) {
          results.push({ filePath: path, fileHash: sourceHash(source), line: match.line, column: match.column,
            text: source.slice(match.start, match.end).slice(0, 1500), captures: Object.fromEntries(match.captures) });
          if (++matched >= args.limit) break;
        }
        if (matched >= args.limit) break;
        await Bun.sleep(0);
      }
      const partial = Boolean(collected?.timedOut || paths.length >= args.maxFiles || matched >= args.limit || skipped.length);
      const data = { capabilities: backends.capabilities(), matches: results, limitReached: matched >= args.limit, skipped, filesConsidered: paths.length, partial };
      const preview = truncateHead(JSON.stringify(data), { maxBytes: 40_000 });
      return { status: partial || preview.truncated ? "partial" : results.length ? "success" : "empty", text: preview.text,
        coverage: { scope: args.filePath ?? args.basePath, complete: !partial, returned: results.length, unit: "matches" },
        truncation: { truncated: preview.truncated, reason: "AST preview is limited to 40000 bytes." },
        continuation: { tool: "ast_search", message: "Narrow filePath/include/language when partial. Optional parsers and rewrite support are listed by operation: capabilities." },
      };

    },
  };
}

export function createAstEditTool(lifecycle: HashlineLifecycle = {}, options: AstBackendOptions = {}): AgentTool<typeof EditSchema> {
  const backends = new AstBackends(options);
  return {
    name: "ast_edit", description: "Replace matching TypeScript/JavaScript or Python syntax nodes in one file. Python requires ast-grep and Python 3; Rust/Go rewrite is unavailable and rejected. Requires fileHash and exact expectedMatches from ast_search. Rejects stale content, overlapping matches, unresolved captures, or invalid replacement syntax. Use LSP for symbol renames across files.",
    parameters: EditSchema, readOnly: false,
    async execute(args, context) {
      context?.signal?.throwIfAborted();
      const language = languageFor(args.filePath, args.language);
      if (language === "rust" || language === "go") throw new Error(`AST ${language} rewrite is unavailable; search is supported when ast-grep is installed. No edit applied.`);
      if (Bun.file(args.filePath).size > 1_000_000) throw new Error("AST edits are limited to files up to 1 MB.");
      const source = await readText(args.filePath);
      if (sourceHash(source) !== args.expectedHash) throw new Error("File changed since ast_search; search again before editing.");
      const matches = (language === "python" ? await backends.matches(source, args.pattern, language, context?.signal) : structuralMatches(source, args.pattern, args.filePath)).sort((a, b) => a.start - b.start);
      if (matches.length !== args.expectedMatches) throw new Error(`Expected ${args.expectedMatches} matches, found ${matches.length}; no edits applied.`);
      for (let index = 1; index < matches.length; index++) if (matches[index].start < matches[index - 1].end) throw new Error("Overlapping matches; narrow the pattern before editing.");
      let next = source;
      for (const match of [...matches].reverse()) {
        const replacement = args.replacement.replace(/\${1,3}[A-Za-z_][\w]*/g, (key) => {
          const value = match.captures.get(key);
          if (value === undefined) throw new Error(`Unresolved capture ${key}; no edits applied.`);
          return value;
        });
        next = next.slice(0, match.start) + replacement + next.slice(match.end);
      }
      if (language === "python") await backends.validatePython(next, context?.signal);
      else parse(next, args.filePath);
      context?.signal?.throwIfAborted();
      await lifecycle.onBeforeModify?.(args.filePath);
      if (await readText(args.filePath) !== source) throw new Error("File changed during edit preparation; no edits applied.");
      context?.signal?.throwIfAborted();
      await Bun.write(args.filePath, next);
      await lifecycle.onAfterModify?.(args.filePath, next);
      return `Replaced ${matches.length} syntax match(es) in ${args.filePath}.`;
    },
  };
}
