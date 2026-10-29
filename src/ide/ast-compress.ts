import { z } from "zod";

import { collectFiles } from "../tools/builtins";
import { computeLineHash, readText, splitLines } from "../tools/hashline-edit";
import type { AgentTool, ToolRegistry } from "../tools/registry";

export type SourceLanguage = "typescript" | "javascript" | "python" | "go" | "rust";

export type DeclarationKind = "import" | "type" | "class" | "function";

export interface SourceDeclaration {
  kind: DeclarationKind;
  name: string;
  docs: string[];
  docstring?: string[];
  signature: string[];
  endLine: number;
  closeLine?: number;
  bodyStartLine?: number;
  bodyEndLine?: number;
  singleLineBody?: boolean;
  bodyText?: string;
  members: SourceDeclaration[];
  indent: string;
}

export function detectLanguage(filePath: string): SourceLanguage | undefined {
  switch (filePath.split(".").pop()?.toLowerCase()) {
    case "ts":
    case "mts":
    case "cts":
    case "tsx":
      return "typescript";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "javascript";
    case "py":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    default:
      return undefined;
  }
}

export function extractDeclarations(source: string, language: SourceLanguage): SourceDeclaration[] {
  return language === "python" ? scanPython(source) : scanBraced(source, language);
}

export function compressToSkeleton(source: string, language: SourceLanguage): string {
  const lines = splitLines(source);
  const rendered: string[] = [];
  for (const declaration of extractDeclarations(source, language)) {
    renderDeclaration(declaration, lines, language, rendered);
  }
  return rendered.join("\n");
}

export function registerAstTools(registry: ToolRegistry): void {
  registry.register(createReadSkeletonTool());
  registry.register(createRepoMapTool());
}

export function createReadSkeletonTool(): AgentTool {
  return {
    name: "read_skeleton",
    description:
      "Read a code file as a skeleton: imports, type declarations, classes, and function signatures with their docs, while implementation bodies fold into an omitted marker with line range and body hash.",
    parameters: z.object({ filePath: z.string().min(1) }),
    readOnly: true,
    execute: async (args) => {
      const { filePath } = args as { filePath: string };
      const language = detectLanguage(filePath);
      if (!language) throw new Error(`unsupported file type for skeleton: ${filePath}`);
      const skeleton = compressToSkeleton(await readText(filePath), language);
      return skeleton.length > 0 ? skeleton : "no declarations found";
    },
  };
}

export function createRepoMapTool(): AgentTool {
  return {
    name: "repo_map",
    description:
      "List the declarations of many source files (TS, JS, TSX, Python, Go, Rust) as a compact map: imports, types, classes, and function signatures per file. Honors the .gitignore in the base path.",
    parameters: z.object({
      basePath: z.string().default("."),
      include: z.string().optional(),
      maxFiles: z.number().int().positive().default(40),
    }),
    readOnly: true,
    execute: async (args) => {
      const request = args as { basePath: string; include?: string; maxFiles: number };
      const files = await collectFiles(request.basePath, request.include, 5000);
      const supported = files.filter((file) => detectLanguage(file) !== undefined).slice(0, request.maxFiles);
      if (supported.length === 0) return "no source files matched";

      const out: string[] = [];
      for (const relative of supported) {
        const language = detectLanguage(relative) as SourceLanguage;
        const source = await readText(`${request.basePath}/${relative}`);
        out.push(`# ${relative}`);
        for (const declaration of extractDeclarations(source, language)) {
          out.push(`  ${summaryLine(declaration)}`);
        }
      }
      const hidden = files.length - supported.length;
      if (hidden > 0) out.push(`... ${hidden} more file(s) not shown`);
      return out.join("\n");
    },
  };
}

function summaryLine(declaration: SourceDeclaration): string {
  return (declaration.signature[0] ?? "").trim().replace(/\s*\{$/, "");
}

function renderDeclaration(
  declaration: SourceDeclaration,
  lines: string[],
  language: SourceLanguage,
  out: string[],
): void {
  for (const doc of declaration.docs) out.push(doc);
  if (declaration.kind === "import" || declaration.kind === "type") {
    for (const line of declaration.signature) out.push(line);
    return;
  }
  if (declaration.kind === "class") {
    for (const line of declaration.signature) out.push(line);
    for (const line of declaration.docstring ?? []) out.push(line);
    for (const member of declaration.members) renderDeclaration(member, lines, language, out);
    if (declaration.closeLine !== undefined) out.push(lines[declaration.closeLine - 1] ?? `${declaration.indent}}`);
    return;
  }

  const range = `lines ${declaration.bodyStartLine ?? 0}-${declaration.bodyEndLine ?? 0}`;
  const hash = computeLineHash(declaration.bodyText ?? "");
  const marker = `implementation omitted (${range}, hash: ${hash})`;
  if (declaration.singleLineBody && declaration.signature.length === 1) {
    const line = declaration.signature[0];
    const open = line.indexOf("{");
    out.push(`${line.slice(0, open + 1)}/* ... ${marker} ... */ }`);
    return;
  }
  for (const line of declaration.signature) out.push(line);
  for (const line of declaration.docstring ?? []) out.push(line);
  if (language === "python") {
    out.push(`${bodyIndentOf(declaration, lines)}# ... ${marker} ...`);
    return;
  }
  out.push(`${declaration.indent}/* ... ${marker} ... */`);
  if (declaration.closeLine !== undefined) out.push(lines[declaration.closeLine - 1] ?? `${declaration.indent}}`);
}

function bodyIndentOf(declaration: SourceDeclaration, lines: string[]): string {
  const first = declaration.bodyStartLine !== undefined ? lines[declaration.bodyStartLine - 1] : undefined;
  if (first !== undefined && first.trim() !== "") return /^[ \t]*/.exec(first)?.[0] ?? declaration.indent;
  return `${declaration.indent}    `;
}

function maskNonCode(source: string, language: SourceLanguage): string {
  const out = source.split("");
  const blank = (index: number): void => {
    if (out[index] !== "\n") out[index] = " ";
  };
  const python = language === "python";
  const lineComment = python ? "#" : "//";
  let index = 0;
  let state: "code" | "interp" | "single" | "double" | "triple" | "template" = "code";
  let interpDepth = 0;
  const quoteReturns: Array<"code" | "interp"> = [];
  const templateReturns: Array<"code" | "interp"> = [];
  const interpDepthStack: number[] = [];

  while (index < source.length) {
    const char = source[index];
    if (state === "code" || state === "interp") {
      if (source.startsWith(lineComment, index)) {
        while (index < source.length && source[index] !== "\n") {
          blank(index);
          index += 1;
        }
        continue;
      }
      if (!python && source.startsWith("/*", index)) {
        blank(index);
        blank(index + 1);
        index += 2;
        while (index < source.length && !source.startsWith("*/", index)) {
          blank(index);
          index += 1;
        }
        if (index < source.length) {
          blank(index);
          blank(index + 1);
          index += 2;
        }
        continue;
      }
      if (python && (source.startsWith('"""', index) || source.startsWith("'''", index))) {
        state = "triple";
        for (let k = 0; k < 3; k += 1) blank(index + k);
        index += 3;
        continue;
      }
      if (char === "'" || char === '"') {
        quoteReturns.push(state === "interp" ? "interp" : "code");
        state = char === "'" ? "single" : "double";
        blank(index);
        index += 1;
        continue;
      }
      if (!python && char === "`") {
        templateReturns.push(state === "interp" ? "interp" : "code");
        state = "template";
        blank(index);
        index += 1;
        continue;
      }
      if (state === "interp") {
        if (char === "{") {
          interpDepth += 1;
        } else if (char === "}") {
          if (interpDepth === 0) {
            blank(index);
            index += 1;
            state = "template";
            interpDepth = interpDepthStack.pop() ?? 0;
            continue;
          }
          interpDepth -= 1;
        }
      }
      index += 1;
      continue;
    }
    if (state === "triple") {
      if (source.startsWith('"""', index) || source.startsWith("'''", index)) {
        for (let k = 0; k < 3; k += 1) blank(index + k);
        index += 3;
        state = "code";
        continue;
      }
      blank(index);
      index += 1;
      continue;
    }
    if (state === "single" || state === "double") {
      const quote = state === "single" ? "'" : '"';
      if (char === "\\") {
        blank(index);
        blank(index + 1);
        index += 2;
        continue;
      }
      if (char === quote) {
        blank(index);
        index += 1;
        state = quoteReturns.pop() ?? "code";
        continue;
      }
      blank(index);
      index += 1;
      continue;
    }
    if (state === "template") {
      if (char === "\\") {
        blank(index);
        blank(index + 1);
        index += 2;
        continue;
      }
      if (source.startsWith("${", index)) {
        blank(index);
        blank(index + 1);
        index += 2;
        interpDepthStack.push(interpDepth);
        interpDepth = 0;
        state = "interp";
        continue;
      }
      if (char === "`") {
        blank(index);
        index += 1;
        state = templateReturns.pop() ?? "code";
        continue;
      }
      blank(index);
      index += 1;
    }
  }
  return out.join("");
}

function lineStartOffsets(source: string): number[] {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") offsets.push(index + 1);
  }
  return offsets;
}

function offsetToLine(offsets: number[], offset: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

function findBodyOpen(masked: string, from: number): number {
  let parens = 0;
  let brackets = 0;
  let sawNewline = false;
  for (let index = from; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "\n") {
      if (sawNewline && parens === 0 && brackets === 0) return -1;
      sawNewline = true;
      continue;
    }
    if (char === "(") parens += 1;
    else if (char === ")") parens -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === ";" && parens === 0 && brackets === 0) return -1;
    else if (char === "{" && parens === 0 && brackets === 0) return index;
  }
  return -1;
}

function findMatchingBrace(masked: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    else if (masked[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function braceDelta(line: string): number {
  return (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
}

function parenDelta(line: string): number {
  return (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
}

interface MatchedDecl {
  kind: DeclarationKind;
  name: string;
  members: boolean;
}

function matchDeclaration(trimmed: string, language: SourceLanguage, memberContext: boolean): MatchedDecl | undefined {
  if (language === "python") {
    if (/^(?:import\s+\S|from\s+\S+\s+import\s)/.test(trimmed)) return { kind: "import", name: "", members: false };
    const pyClass = /^class\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (pyClass) return { kind: "class", name: pyClass[1], members: true };
    const pyFunc = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (pyFunc) return { kind: "function", name: pyFunc[1], members: false };
    return undefined;
  }
  if (language === "go") {
    if (/^import\b/.test(trimmed)) return { kind: "import", name: "", members: false };
    const goType = /^type\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (goType) return { kind: "type", name: goType[1], members: false };
    const goFunc = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(trimmed);
    if (goFunc) return { kind: "function", name: goFunc[1], members: false };
    return undefined;
  }
  if (language === "rust") {
    if (/^(?:pub\s+)?(?:use|mod|extern\s+crate)\b/.test(trimmed)) return { kind: "import", name: "", members: false };
    const rsType = /^(?:pub\s+)?(?:struct|enum|trait|type|union)\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (rsType) return { kind: "type", name: rsType[1], members: false };
    if (/^(?:pub\s+)?impl\b/.test(trimmed)) return { kind: "class", name: "impl", members: true };
    const rsFunc =
      /^(?:pub\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (rsFunc) return { kind: "function", name: rsFunc[1], members: false };
    return undefined;
  }

  if (/^(?:export\s+)?import\b/.test(trimmed) || /^export\s+(?:\*|\{)/.test(trimmed)) {
    return { kind: "import", name: "", members: false };
  }
  const tsType =
    /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:interface|type|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/.exec(
      trimmed,
    );
  if (tsType) return { kind: "type", name: tsType[1], members: false };
  const tsClass =
    /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
  if (tsClass) return { kind: "class", name: tsClass[1], members: true };
  const tsFunction =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(trimmed) ??
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.exec(
      trimmed,
    );
  if (tsFunction) return { kind: "function", name: tsFunction[1], members: false };
  if (memberContext) {
    const tsMember =
      /^(?:(?:public|private|protected|static|async|readonly|abstract|override|get|set)\s+)*([#A-Za-z_$][\w$]*)\s*(?:<[^(]*>)?\s*\(/.exec(
        trimmed,
      );
    if (tsMember) return { kind: "function", name: tsMember[1], members: false };
    const tsField =
      /^(?:(?:public|private|protected|static|readonly|declare|override)\s+)*([#A-Za-z_$][\w$]*)\s*[!?]?\s*[:=]/.exec(
        trimmed,
      );
    if (tsField) return { kind: "type", name: tsField[1], members: false };
  }
  return undefined;
}

function collectDocs(lines: string[], maskedLines: string[], declIndex: number): { docs: string[]; start: number } {
  const docs: string[] = [];
  let start = declIndex;
  while (start > 0) {
    const previous = lines[start - 1];
    if (previous.trim() === "") break;
    const isComment = maskedLines[start - 1].trim() === "";
    const isDecorator = /^\s*@/.test(previous);
    if (!isComment && !isDecorator) break;
    docs.unshift(previous);
    start -= 1;
  }
  return { docs, start };
}

function findStatementEnd(lines: string[], maskedLines: string[], start: number, limit: number): number {
  let depth = 0;
  for (let index = start; index < limit; index += 1) {
    depth += braceDelta(maskedLines[index]) + parenDelta(maskedLines[index]);
    const trimmed = lines[index].trim();
    const selfContained = depth === 0 && index === start && !/[({,]$/.test(trimmed) && !trimmed.endsWith("=>");
    if (selfContained) return index;
    if (index > start && depth <= 0 && /[;})]$/.test(trimmed)) return index;
  }
  return limit - 1;
}

function lineDepths(maskedLines: string[]): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const line of maskedLines) {
    depths.push(depth);
    depth += braceDelta(line);
  }
  return depths;
}

function scanBraced(source: string, language: SourceLanguage): SourceDeclaration[] {
  const lines = splitLines(source);
  const masked = maskNonCode(source, language);
  const maskedLines = splitLines(masked);
  const offsets = lineStartOffsets(source);
  return scanBracedRange(source, masked, lines, maskedLines, offsets, language, 0, lines.length, 0);
}

function scanBracedRange(
  source: string,
  masked: string,
  lines: string[],
  maskedLines: string[],
  offsets: number[],
  language: SourceLanguage,
  fromLine: number,
  toLine: number,
  depth: number,
): SourceDeclaration[] {
  const declarations: SourceDeclaration[] = [];
  const depths = lineDepths(maskedLines);
  let index = fromLine;

  while (index < toLine) {
    const maskedTrimmed = maskedLines[index].trim();
    if (maskedTrimmed === "" || depths[index] !== depth) {
      index += 1;
      continue;
    }
    const match = matchDeclaration(lines[index].trim(), language, depth > 0);
    if (!match) {
      index += 1;
      continue;
    }

    const { docs } = collectDocs(lines, maskedLines, index);
    const indent = /^[ \t]*/.exec(lines[index])?.[0] ?? "";
    const declStartOffset = offsets[index];

    if (match.kind === "import" || match.kind === "type") {
      const endLine = findStatementEnd(lines, maskedLines, index, toLine);
      declarations.push({
        kind: match.kind,
        name: match.name,
        docs,
        signature: lines.slice(index, endLine + 1),
        endLine: endLine + 1,
        members: [],
        indent,
      });
      index = endLine + 1;
      continue;
    }

    const openOffset = findBodyOpen(masked, declStartOffset);
    if (openOffset === -1) {
      const endLine = findStatementEnd(lines, maskedLines, index, toLine);
      declarations.push({
        kind: "type",
        name: match.name,
        docs,
        signature: lines.slice(index, endLine + 1),
        endLine: endLine + 1,
        members: [],
        indent,
      });
      index = endLine + 1;
      continue;
    }

    const closeOffset = findMatchingBrace(masked, openOffset);
    const openLine = offsetToLine(offsets, openOffset);
    const closeLine = closeOffset === -1 ? lines.length - 1 : offsetToLine(offsets, closeOffset);
    const singleLineBody = openLine === closeLine;
    const openLineText = lines[openLine];
    const openColumn = openOffset - offsets[openLine];
    const signature = [...lines.slice(index, openLine), openLineText.slice(0, openColumn + 1)];
    const bodyText = source.slice(openOffset + 1, closeOffset === -1 ? source.length : closeOffset);

    const declaration: SourceDeclaration = {
      kind: match.kind,
      name: match.name,
      docs,
      signature,
      endLine: closeLine + 1,
      closeLine: closeLine + 1,
      bodyStartLine: openLine + 1,
      bodyEndLine: closeLine + 1,
      singleLineBody,
      bodyText,
      members: [],
      indent,
    };

    if (match.members && closeLine > openLine) {
      declaration.members = scanBracedRange(
        source,
        masked,
        lines,
        maskedLines,
        offsets,
        language,
        openLine + 1,
        closeLine,
        depth + 1,
      );
    }
    declarations.push(declaration);
    index = closeLine + 1;
  }
  return declarations;
}

function scanPython(source: string): SourceDeclaration[] {
  const lines = splitLines(source);
  const maskedLines = splitLines(maskNonCode(source, "python"));
  return scanPythonRange(lines, maskedLines, 0, lines.length, 0);
}

function scanPythonRange(
  lines: string[],
  maskedLines: string[],
  fromLine: number,
  toLine: number,
  minIndent: number,
): SourceDeclaration[] {
  const declarations: SourceDeclaration[] = [];
  let index = fromLine;

  while (index < toLine) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "" || maskedLines[index].trim() === "") {
      index += 1;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent < minIndent) {
      index += 1;
      continue;
    }
    const match = matchDeclaration(trimmed, "python", minIndent > 0);
    if (!match) {
      index += 1;
      continue;
    }

    const { docs } = collectDocs(lines, maskedLines, index);
    const bodyEnd = findPythonBodyEnd(lines, index + 1, toLine, indent) - 1;
    const hasBody = bodyEnd >= index + 1;

    const declaration: SourceDeclaration = {
      kind: match.kind,
      name: match.name,
      docs,
      signature: [line],
      endLine: (hasBody ? bodyEnd : index) + 1,
      bodyStartLine: hasBody ? index + 2 : undefined,
      bodyEndLine: hasBody ? bodyEnd + 1 : undefined,
      members: [],
      indent: line.slice(0, indent),
    };

    if (hasBody) {
      const docstring = pythonDocstring(lines, index + 1, bodyEnd);
      if (docstring) {
        declaration.docstring = docstring.lines;
        if (match.kind === "function") {
          const remaining = bodyEnd + 1 - docstring.endLine;
          declaration.bodyStartLine = remaining > 0 ? docstring.endLine + 1 : undefined;
          declaration.bodyEndLine = remaining > 0 ? bodyEnd + 1 : undefined;
        }
      }
    }
    if (declaration.bodyStartLine !== undefined && declaration.bodyEndLine !== undefined) {
      declaration.bodyText = lines.slice(declaration.bodyStartLine - 1, declaration.bodyEndLine).join("\n");
    }
    if (match.kind === "class" && hasBody) {
      declaration.members = scanPythonRange(lines, maskedLines, index + 1, bodyEnd + 1, indent + 1);
    }

    declarations.push(declaration);
    index = hasBody ? bodyEnd + 1 : index + 1;
  }
  return declarations;
}

function findPythonBodyEnd(lines: string[], from: number, to: number, parentIndent: number): number {
  let index = from;
  while (index < to) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= parentIndent) break;
    index += 1;
  }
  return index;
}

function pythonDocstring(
  lines: string[],
  from: number,
  to: number,
): { lines: string[]; endLine: number } | undefined {
  let index = from;
  while (index <= to && lines[index].trim() === "") index += 1;
  if (index > to) return undefined;
  const trimmed = lines[index].trim();
  const triple = /^("""|''')/.exec(trimmed);
  if (triple) {
    const marker = triple[1];
    const collected = [lines[index]];
    if (trimmed.slice(3).includes(marker)) return { lines: collected, endLine: index + 1 };
    for (let inner = index + 1; inner <= to; inner += 1) {
      collected.push(lines[inner]);
      if (lines[inner].includes(marker)) return { lines: collected, endLine: inner + 1 };
    }
    return undefined;
  }
  if (/^["']/.test(trimmed)) return { lines: [lines[index]], endLine: index + 1 };
  return undefined;
}
