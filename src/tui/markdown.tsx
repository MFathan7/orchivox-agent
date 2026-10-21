import React from "react";
import { Box, Text } from "ink";

import type { RenderRow } from "./rows";
import {
  charDisplayWidth,
  displayWidth,
  expandTabs,
  fitDisplayText,
  wrapPreservingWhitespace,
  wrapText,
} from "./text-wrap";
import { getTheme, type Theme } from "./theme";

export interface MarkdownViewProps {
  content: string;
  width?: number;
  theme?: Theme;
}

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "code"; language: string; lines: string[] }
  | { kind: "bullet"; items: Array<{ text: string; indent: number }> }
  | { kind: "task"; items: Array<{ text: string; indent: number; checked: boolean }> }
  | { kind: "numbered"; items: Array<{ text: string; indent: number }> }
  | { kind: "quote"; lines: string[] }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "hr" }
  | { kind: "paragraph"; lines: string[] };

export type TokenKind = "keyword" | "string" | "comment" | "number" | "type" | "text";

const PANEL_PAD = " ";
const PANEL_END = "\u200b";
const CODE_MARGIN = 2;

export interface HighlightToken {
  kind: TokenKind;
  text: string;
}

const LANGUAGE_KEYWORDS: Record<string, string[]> = {
  typescript: [
    "const", "let", "var", "function", "class", "interface", "type", "enum", "return", "if", "else", "for", "while",
    "import", "from", "export", "default", "async", "await", "new", "try", "catch", "finally", "throw", "extends",
    "implements", "typeof", "instanceof", "null", "undefined", "true", "false", "void", "this", "as", "of", "in",
  ],
  python: [
    "def", "class", "return", "if", "elif", "else", "for", "while", "import", "from", "as", "with", "try", "except",
    "finally", "raise", "None", "True", "False", "async", "await", "lambda", "pass", "yield", "global", "assert",
    "self", "in", "is", "not", "and", "or",
  ],
  go: [
    "func", "package", "import", "type", "struct", "interface", "return", "if", "else", "for", "range", "go", "defer",
    "chan", "select", "switch", "case", "default", "var", "const", "map", "nil", "true", "false", "break", "continue",
  ],
  rust: [
    "fn", "let", "mut", "struct", "enum", "impl", "trait", "use", "pub", "mod", "match", "if", "else", "for", "while",
    "loop", "return", "async", "await", "move", "ref", "self", "Self", "true", "false", "crate", "super", "where",
    "dyn", "unsafe", "const", "static",
  ],
  json: ["true", "false", "null"],
  bash: [
    "if", "then", "else", "elif", "fi", "for", "do", "done", "while", "case", "esac", "function", "local", "export",
    "return", "echo", "cd", "set", "shift", "exit", "read",
  ],
};

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  golang: "go",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
};

export function normalizeLanguage(language: string): string {
  const lower = language.trim().toLowerCase();
  return LANGUAGE_ALIASES[lower] ?? lower;
}

const HTML_TAG = /<\/?(?:br|p|div|span|strong|b|em|i|code|pre|li|ul|ol|table|thead|tbody|tr|td|th|h[1-6]|blockquote|a|hr|details|summary|img)\b[^>]*>/gi;

function safeCodePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return "";
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => safeCodePoint(Number(dec)));
}

function htmlLineToText(line: string): string {
  let text = line;
  text = text.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  text = text.replace(/<img\b[^>]*alt\s*=\s*["']([^"']*)["'][^>]*\/?>/gi, (_match, alt: string) =>
    alt ? `[image: ${alt}]` : "[image]",
  );
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|details|summary)>/gi, "\n");
  text = text.replace(/<li\b[^>]*>/gi, "- ");
  text = text.replace(/<(strong|b)\b[^>]*>/gi, "**").replace(/<\/(strong|b)>/gi, "**");
  text = text.replace(/<(em|i)\b[^>]*>/gi, "*").replace(/<\/(em|i)>/gi, "*");
  text = text.replace(/<code\b[^>]*>/gi, "`").replace(/<\/code>/gi, "`");
  text = text.replace(/<(td|th)\b[^>]*>/gi, " | ");
  text = text.replace(/<summary\b[^>]*>/gi, "\n**").replace(/<\/summary>/gi, "**\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
  text = text.replace(HTML_TAG, "");
  return decodeEntities(text);
}

export function normalizeHtml(content: string): string {
  const lines = content.split("\n");
  const output: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      output.push(line);
      continue;
    }
    output.push(inFence ? line : htmlLineToText(line));
  }
  return expandTabs(output.join("\n"));
}

function listIndent(line: string): number {
  const leading = /^\s*/.exec(line)?.[0].length ?? 0;
  return Math.min(3, Math.floor(leading / 2));
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function isHorizontalRule(line: string): boolean {
  return /^\s*([-*_])\1{2,}\s*$/.test(line);
}

export function parseMarkdown(content: string): MarkdownBlock[] {
  const lines = normalizeHtml(content).split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const language = fence[1].trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language, lines: codeLines });
      continue;
    }

    if (isHorizontalRule(line)) {
      blocks.push({ kind: "hr" });
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const rawLevel = heading[1].length;
      const level = (rawLevel >= 3 ? 3 : rawLevel) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) {
      const items: Array<{ text: string; indent: number; checked: boolean }> = [];
      while (index < lines.length && /^\s*[-*+]\s+\[[ xX]\]\s+/.test(lines[index])) {
        const match = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(lines[index]);
        if (match) {
          items.push({
            text: match[2],
            indent: listIndent(lines[index]),
            checked: match[1].toLowerCase() === "x",
          });
        }
        index += 1;
      }
      blocks.push({ kind: "task", items });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: Array<{ text: string; indent: number }> = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(lines[index])) break;
        items.push({ text: lines[index].replace(/^\s*[-*+]\s+/, ""), indent: listIndent(lines[index]) });
        index += 1;
      }
      blocks.push({ kind: "bullet", items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: Array<{ text: string; indent: number }> = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push({ text: lines[index].replace(/^\s*\d+[.)]\s+/, ""), indent: listIndent(lines[index]) });
        index += 1;
      }
      blocks.push({ kind: "numbered", items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", lines: quoteLines });
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      !/^\s*```/.test(lines[index]) &&
      !isHorizontalRule(lines[index]) &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*[-*+]\s+/.test(lines[index]) &&
      !/^\s*\d+[.)]\s+/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index]) &&
      !(lines[index].includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1]))
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }

  const merged: MarkdownBlock[] = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (block.kind === "numbered" && previous?.kind === "numbered") {
      previous.items.push(...block.items);
    } else {
      merged.push(block);
    }
  }
  return merged;
}

export function highlightLine(line: string, language: string): HighlightToken[] {
  const normalized = normalizeLanguage(language);
  const keywords = new Set(LANGUAGE_KEYWORDS[normalized] ?? LANGUAGE_KEYWORDS.typescript);
  const tokens: HighlightToken[] = [];
  const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/.*$|#.*$)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;

  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > cursor) tokens.push({ kind: "text", text: line.slice(cursor, match.index) });
    const [full, stringPart, commentPart, numberPart, wordPart] = match;
    if (stringPart !== undefined) tokens.push({ kind: "string", text: full });
    else if (commentPart !== undefined) tokens.push({ kind: "comment", text: full });
    else if (numberPart !== undefined) tokens.push({ kind: "number", text: full });
    else if (wordPart !== undefined) {
      tokens.push({ kind: keywords.has(wordPart) ? "keyword" : "text", text: full });
    }
    cursor = match.index + full.length;
  }
  if (cursor < line.length) tokens.push({ kind: "text", text: line.slice(cursor) });
  return tokens;
}

const FILE_REFERENCE = /((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|json|md|ya?ml|toml|sh))(?::(\d+))?/g;

interface InlineMatch {
  index: number;
  kind: string;
  match: RegExpExecArray;
}

const INLINE_CODE = /`([^`\n]+)`/;
const INLINE_BOLD = /\*\*([^*\n]+)\*\*/;
const INLINE_STRIKE = /~~([^~\n]+)~~/;
const INLINE_ITALIC_STAR = /(?<!\*)\*([^*\n]+)\*(?!\*)/;
const INLINE_ITALIC_UNDERSCORE = /(?<![\w])_([^_\n]+)_(?![\w])/;
const INLINE_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/;
const INLINE_AUTOLINK = /<(https?:\/\/[^>\s]+)>/;

export function renderInline(text: string, theme: Theme): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const rest = text.slice(cursor);
    const candidates: InlineMatch[] = [];

    const add = (kind: string, pattern: RegExp): void => {
      pattern.lastIndex = 0;
      const match = pattern.exec(rest);
      if (match) candidates.push({ index: match.index, kind, match });
    };

    add("code", INLINE_CODE);
    add("bold", INLINE_BOLD);
    add("strike", INLINE_STRIKE);
    add("italic", INLINE_ITALIC_STAR);
    add("italic", INLINE_ITALIC_UNDERSCORE);
    add("link", INLINE_LINK);
    add("autolink", INLINE_AUTOLINK);

    FILE_REFERENCE.lastIndex = 0;
    let fileMatch: RegExpExecArray | null;
    while ((fileMatch = FILE_REFERENCE.exec(rest)) !== null) {
      const before = fileMatch.index === 0 ? "" : rest[fileMatch.index - 1];
      if (before === "" || /[\s("'[]/.test(before)) {
        candidates.push({ index: fileMatch.index, kind: "file", match: fileMatch });
        break;
      }
    }

    if (candidates.length === 0) {
      nodes.push(rest);
      break;
    }

    candidates.sort((left, right) => left.index - right.index || left.match[0].length - right.match[0].length);
    const winner = candidates[0];
    if (winner.index > 0) nodes.push(rest.slice(0, winner.index));

    const key = `${cursor}-${winner.kind}-${winner.index}`;
    if (winner.kind === "code") {
      nodes.push(
        <Text key={key} color={theme.syntax.string}>
          {winner.match[1]}
        </Text>,
      );
    } else if (winner.kind === "bold") {
      nodes.push(
        <Text key={key} bold>
          {winner.match[1]}
        </Text>,
      );
    } else if (winner.kind === "strike") {
      nodes.push(
        <Text key={key} strikethrough dimColor>
          {winner.match[1]}
        </Text>,
      );
    } else if (winner.kind === "italic") {
      nodes.push(
        <Text key={key} italic>
          {winner.match[1]}
        </Text>,
      );
    } else if (winner.kind === "link") {
      const label = winner.match[1];
      const url = winner.match[2];
      nodes.push(
        <Text key={key}>
          <Text color={theme.accent}>{label}</Text>
          {label !== url ? <Text color={theme.muted}> ({url})</Text> : null}
        </Text>,
      );
    } else if (winner.kind === "autolink") {
      nodes.push(
        <Text key={key} color={theme.accent}>
          {winner.match[1]}
        </Text>,
      );
    } else {
      const marker = winner.match[2] ? `:${winner.match[2]}` : "";
      nodes.push(
        <Text key={key} color={theme.modes.plan.primary} bold>
          {`${winner.match[1]}${marker}`}
        </Text>,
      );
    }

    cursor += winner.index + winner.match[0].length;
  }

  return nodes;
}

export function inlinePlainText(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1");
}

function truncateDisplay(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  if (width <= 3) return value.slice(0, Math.max(0, width));
  let output = "";
  let used = 0;
  for (const char of value) {
    const charWidth = displayWidth(char);
    if (used + charWidth > width - 3) break;
    output += char;
    used += charWidth;
  }
  return `${output}...`;
}

function cellView(value: string, width: number): { text: string; plain: string; truncated: boolean } {
  const plain = inlinePlainText(value).trim();
  if (displayWidth(plain) <= width) return { text: value, plain, truncated: false };
  const text = truncateDisplay(plain, width);
  return { text, plain: text, truncated: true };
}

function renderTable(
  block: Extract<MarkdownBlock, { kind: "table" }>,
  index: number,
  theme: Theme,
  width: number,
): React.ReactElement {
  const columnCount = Math.max(
    block.headers.length,
    ...block.rows.map((row) => row.length),
    0,
  );
  const available = Math.max(12, width - 2);
  if (available < 30 || columnCount === 0) {
    return (
      <Box key={index} flexDirection="column">
        {block.rows.map((row, rowIndex) => (
          <Box key={`row-${rowIndex}`} flexDirection="column" marginTop={rowIndex === 0 ? 0 : 1}>
            {block.headers.map((header, column) => (
              <Text key={`cell-${rowIndex}-${column}`}>
                <Text color={theme.accent} bold>{header}: </Text>
                <Text color={theme.text}>{renderInline(row[column] ?? "", theme)}</Text>
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    );
  }

  const rawWidths = Array.from({ length: columnCount }, (_, column) => {
    const values = [block.headers[column] ?? "", ...block.rows.map((row) => row[column] ?? "")];
    return Math.min(
      28,
      Math.max(3, ...values.map((value) => displayWidth(inlinePlainText(value).trim()))),
    );
  });
  const separators = Math.max(0, columnCount - 1) * 3;
  const total = rawWidths.reduce((sum, value) => sum + value, 0) + separators;
  const scale = total > available ? available / total : 1;
  const widths = rawWidths.map((value) => Math.max(3, Math.floor(value * scale)));

  return (
    <Box key={index} flexDirection="column">
      <Text>
        {Array.from({ length: columnCount }, (_, column) => {
          const cell = cellView(block.headers[column] ?? "", widths[column]);
          return (
            <Text key={`head-${column}`} bold color={theme.accent}>
              {cell.truncated ? cell.text : renderInline(cell.text, theme)}
              {" ".repeat(Math.max(0, widths[column] - displayWidth(cell.plain)))}
              {column < columnCount - 1 ? " │ " : ""}
            </Text>
          );
        })}
      </Text>
      <Text color={theme.border.passive}>
        {widths.map((value) => "─".repeat(value)).join("─┼─")}
      </Text>
      {block.rows.map((row, rowIndex) => (
        <Text key={`row-${rowIndex}`}>
          {Array.from({ length: columnCount }, (_, column) => {
            const cell = cellView(row[column] ?? "", widths[column]);
            return (
              <Text key={`cell-${rowIndex}-${column}`} color={theme.text}>
                {cell.truncated ? cell.text : renderInline(cell.text, theme)}
                {" ".repeat(Math.max(0, widths[column] - displayWidth(cell.plain)))}
                {column < columnCount - 1 ? " │ " : ""}
              </Text>
            );
          })}
        </Text>
      ))}
    </Box>
  );
}

function codeTokenColor(kind: HighlightToken["kind"], theme: Theme): string {
  if (kind === "keyword") return theme.syntax.keyword;
  if (kind === "string") return theme.syntax.string;
  if (kind === "comment") return theme.syntax.comment;
  if (kind === "number") return theme.syntax.number;
  return theme.text;
}

type InlineSegmentKind = "text" | "code" | "bold" | "strike" | "italic" | "link" | "url" | "file";

interface InlineSegment {
  kind: InlineSegmentKind;
  text: string;
}

interface InlineStyleOptions {
  textColor?: string;
  textBold?: boolean;
  textItalic?: boolean;
  textDim?: boolean;
}

function pushInlineSegment(segments: InlineSegment[], kind: InlineSegmentKind, text: string): void {
  if (text.length === 0) return;
  const previous = segments[segments.length - 1];
  if (previous?.kind === kind) previous.text += text;
  else segments.push({ kind, text });
}

function parseInlineSegments(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const rest = text.slice(cursor);
    const candidates: InlineMatch[] = [];

    const add = (kind: string, pattern: RegExp): void => {
      pattern.lastIndex = 0;
      const match = pattern.exec(rest);
      if (match) candidates.push({ index: match.index, kind, match });
    };

    add("code", INLINE_CODE);
    add("bold", INLINE_BOLD);
    add("strike", INLINE_STRIKE);
    add("italic", INLINE_ITALIC_STAR);
    add("italic", INLINE_ITALIC_UNDERSCORE);
    add("link", INLINE_LINK);
    add("autolink", INLINE_AUTOLINK);

    FILE_REFERENCE.lastIndex = 0;
    let fileMatch: RegExpExecArray | null;
    while ((fileMatch = FILE_REFERENCE.exec(rest)) !== null) {
      const before = fileMatch.index === 0 ? "" : rest[fileMatch.index - 1];
      if (before === "" || /[\s("'[]/.test(before)) {
        candidates.push({ index: fileMatch.index, kind: "file", match: fileMatch });
        break;
      }
    }

    if (candidates.length === 0) {
      pushInlineSegment(segments, "text", rest);
      break;
    }

    candidates.sort((left, right) => left.index - right.index || left.match[0].length - right.match[0].length);
    const winner = candidates[0];
    if (winner.index > 0) pushInlineSegment(segments, "text", rest.slice(0, winner.index));

    if (winner.kind === "code") {
      pushInlineSegment(segments, "code", winner.match[1]);
    } else if (winner.kind === "bold") {
      pushInlineSegment(segments, "bold", winner.match[1]);
    } else if (winner.kind === "strike") {
      pushInlineSegment(segments, "strike", winner.match[1]);
    } else if (winner.kind === "italic") {
      pushInlineSegment(segments, "italic", winner.match[1]);
    } else if (winner.kind === "link") {
      const label = winner.match[1];
      const url = winner.match[2];
      pushInlineSegment(segments, "link", label);
      if (label !== url) {
        pushInlineSegment(segments, "text", " (");
        pushInlineSegment(segments, "url", url);
        pushInlineSegment(segments, "text", ")");
      }
    } else if (winner.kind === "autolink") {
      pushInlineSegment(segments, "link", winner.match[1]);
    } else {
      const marker = winner.match[2] ? `:${winner.match[2]}` : "";
      pushInlineSegment(segments, "file", `${winner.match[1]}${marker}`);
    }

    cursor += winner.index + winner.match[0].length;
  }

  return segments;
}

function trimTrailingWhitespace(segments: InlineSegment[]): InlineSegment[] {
  while (segments.length > 0) {
    const last = segments[segments.length - 1];
    last.text = last.text.replace(/\s+$/, "");
    if (last.text.length > 0) break;
    segments.pop();
  }
  return segments;
}

function wrapInlineSegments(segments: InlineSegment[], width: number): InlineSegment[][] {
  const max = Math.max(1, width);
  const rows: InlineSegment[][] = [];
  let row: InlineSegment[] = [];
  let rowWidth = 0;

  const append = (kind: InlineSegmentKind, text: string): void => {
    pushInlineSegment(row, kind, text);
    rowWidth += displayWidth(text);
  };
  const flush = (): void => {
    rows.push(trimTrailingWhitespace(row));
    row = [];
    rowWidth = 0;
  };

  for (const segment of segments) {
    const tokens = segment.text.match(/\s+|\S+/g) ?? [];
    for (const token of tokens) {
      const tokenWidth = displayWidth(token);
      const whitespace = /^\s+$/.test(token);
      if (rowWidth === 0 && whitespace) continue;
      if (rowWidth + tokenWidth <= max) {
        append(segment.kind, token);
        continue;
      }
      if (whitespace) {
        flush();
        continue;
      }
      if (tokenWidth <= max) {
        flush();
        append(segment.kind, token);
        continue;
      }
      for (const char of token) {
        const charWidth = charDisplayWidth(char);
        if (rowWidth > 0 && rowWidth + charWidth > max) flush();
        append(segment.kind, char);
      }
    }
  }

  if (row.length > 0 || rows.length === 0) flush();
  return rows;
}

function inlineSegmentNode(
  segment: InlineSegment,
  theme: Theme,
  key: string,
  style: InlineStyleOptions,
): React.ReactNode {
  switch (segment.kind) {
    case "code":
      return <Text key={key} color={theme.syntax.string}>{segment.text}</Text>;
    case "bold":
      return <Text key={key} bold>{segment.text}</Text>;
    case "strike":
      return <Text key={key} strikethrough dimColor>{segment.text}</Text>;
    case "italic":
      return <Text key={key} italic>{segment.text}</Text>;
    case "link":
      return <Text key={key} color={theme.accent}>{segment.text}</Text>;
    case "url":
      return <Text key={key} color={theme.muted}>{segment.text}</Text>;
    case "file":
      return <Text key={key} color={theme.modes.plan.primary} bold>{segment.text}</Text>;
    default:
      return (
        <Text
          key={key}
          color={style.textColor ?? theme.text}
          bold={style.textBold}
          italic={style.textItalic}
          dimColor={style.textDim}
        >
          {segment.text}
        </Text>
      );
  }
}

function inlineSegmentsNode(
  segments: InlineSegment[],
  theme: Theme,
  keyPrefix: string,
  style: InlineStyleOptions = {},
): React.ReactNode {
  return segments.map((segment, index) =>
    inlineSegmentNode(segment, theme, `${keyPrefix}-${index}`, style),
  );
}

function inlineRows(
  segments: InlineSegment[],
  width: number,
  theme: Theme,
  keyPrefix: string,
  style: InlineStyleOptions = {},
): RenderRow[] {
  return wrapInlineSegments(segments, width).map((row, index) => ({
    key: `${keyPrefix}-${index}`,
    node: (
      <Text
        wrap="truncate"
        color={style.textColor ?? theme.text}
        bold={style.textBold}
        italic={style.textItalic}
        dimColor={style.textDim}
      >
        {inlineSegmentsNode(row, theme, `${keyPrefix}-${index}`, style)}
      </Text>
    ),
  }));
}

function tableRows(
  block: Extract<MarkdownBlock, { kind: "table" }>,
  blockIndex: number,
  theme: Theme,
  width: number,
): RenderRow[] {
  const rows: RenderRow[] = [];
  const columnCount = Math.max(block.headers.length, ...block.rows.map((row) => row.length), 0);
  const available = Math.max(12, width - 2);
  if (available < 30 || columnCount === 0) {
    for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
      const row = block.rows[rowIndex];
      for (let column = 0; column < block.headers.length; column += 1) {
        const header = block.headers[column] ?? "";
        const value = row[column] ?? "";
        const prefix = `${header}: `;
        const prefixWidth = displayWidth(prefix);
        const valueRows = wrapInlineSegments(
          parseInlineSegments(value),
          Math.max(1, width - prefixWidth),
        );
        valueRows.forEach((valueRow, valueIndex) => {
          rows.push({
            key: `md-${blockIndex}-table-${rowIndex}-${column}-${valueIndex}`,
            node: (
              <Text wrap="truncate" color={theme.text}>
                <Text bold color={theme.accent}>
                  {valueIndex === 0 ? prefix : " ".repeat(prefixWidth)}
                </Text>
                {inlineSegmentsNode(
                  valueRow,
                  theme,
                  `md-${blockIndex}-table-${rowIndex}-${column}-${valueIndex}`,
                )}
              </Text>
            ),
          });
        });
      }
    }
    return rows;
  }

  const rawWidths = Array.from({ length: columnCount }, (_, column) => {
    const values = [block.headers[column] ?? "", ...block.rows.map((row) => row[column] ?? "")];
    return Math.min(
      28,
      Math.max(3, ...values.map((value) => displayWidth(inlinePlainText(value).trim()))),
    );
  });
  const separators = Math.max(0, columnCount - 1) * 3;
  const total = rawWidths.reduce((sum, value) => sum + value, 0) + separators;
  const scale = total > available ? available / total : 1;
  const widths = rawWidths.map((value) => Math.max(3, Math.floor(value * scale)));

  const renderRow = (
    cells: string[],
    rowIndex: number,
    header: boolean,
  ): RenderRow => {
    const nodes: React.ReactNode[] = [];
    for (let column = 0; column < columnCount; column += 1) {
      const cell = cellView(cells[column] ?? "", widths[column]);
      nodes.push(
        header ? (
          <Text key={`cell-${rowIndex}-${column}`} bold color={theme.accent}>
            {cell.truncated ? cell.text : renderInline(cell.text, theme)}
            {" ".repeat(Math.max(0, widths[column] - displayWidth(cell.plain)))}
            {column < columnCount - 1 ? " │ " : ""}
          </Text>
        ) : (
          <Text key={`cell-${rowIndex}-${column}`} color={theme.text}>
            {cell.truncated ? cell.text : renderInline(cell.text, theme)}
            {" ".repeat(Math.max(0, widths[column] - displayWidth(cell.plain)))}
            {column < columnCount - 1 ? " │ " : ""}
          </Text>
        ),
      );
    }
    return {
      key: `md-${blockIndex}-table-row-${rowIndex}`,
      node: <Text wrap="truncate">{nodes}</Text>,
    };
  };

  rows.push(renderRow(block.headers, 0, true));
  rows.push({
    key: `md-${blockIndex}-table-separator`,
    node: (
      <Text color={theme.border.passive} wrap="truncate">
        {widths.map((value) => "─".repeat(value)).join("─┼─")}
      </Text>
    ),
  });
  block.rows.forEach((row, rowIndex) => {
    rows.push(renderRow(row, rowIndex + 1, false));
  });
  return rows;
}

export function markdownRows(
  content: string,
  width: number,
  theme: Theme,
): RenderRow[] {
  const blocks = parseMarkdown(content);
  const safeWidth = Math.max(12, width);
  const rows: RenderRow[] = [];

  blocks.forEach((block, blockIndex) => {
    if (rows.length > 0) {
      rows.push({
        key: `md-${blockIndex}-block-gap`,
        node: <Text> </Text>,
      });
    }

    switch (block.kind) {
      case "heading": {
        const headingRows = inlineRows(
          parseInlineSegments(block.text),
          safeWidth,
          theme,
          `md-${blockIndex}-heading`,
          {
            textColor: block.level === 1 ? theme.accent : theme.text,
            textBold: true,
          },
        );
        rows.push(...headingRows);
        break;
      }
      case "paragraph": {
        block.lines.forEach((line, lineIndex) => {
          if (line.length === 0) {
            rows.push({
              key: `md-${blockIndex}-paragraph-${lineIndex}-blank`,
              node: <Text> </Text>,
            });
            return;
          }
          rows.push(
            ...inlineRows(
              parseInlineSegments(line),
              safeWidth,
              theme,
              `md-${blockIndex}-paragraph-${lineIndex}`,
            ),
          );
        });
        break;
      }
      case "code": {
        const showNumbers = safeWidth >= 60;
        const panelWidth = Math.max(11, safeWidth - CODE_MARGIN * 2 - 1);
        const margin = " ".repeat(CODE_MARGIN);
        const leftPad = 2;
        const gutterWidth = showNumbers ? 7 : 0;
        const codeWidth = Math.max(8, panelWidth - leftPad - gutterWidth - 1);
        const background = theme.code.background;
        const paddingRow = (key: string): RenderRow => ({
          key,
          node: (
            <Text wrap="truncate">
              {margin}
              <Text backgroundColor={background}>
                {PANEL_PAD.repeat(panelWidth)}
                {PANEL_END}
              </Text>
            </Text>
          ),
        });

        rows.push(paddingRow(`md-${blockIndex}-code-top`));
        if (block.language) {
          const label = fitDisplayText(`  ${block.language}`, panelWidth);
          rows.push({
            key: `md-${blockIndex}-code-language`,
            node: (
              <Text wrap="truncate">
                {margin}
                <Text bold color={theme.syntax.type} backgroundColor={background}>
                  {label}
                  {PANEL_PAD.repeat(Math.max(0, panelWidth - displayWidth(label)))}
                  {PANEL_END}
                </Text>
              </Text>
            ),
          });
        }
        block.lines.forEach((line, lineIndex) => {
          wrapPreservingWhitespace(line, codeWidth).forEach((chunk, chunkIndex) => {
            const gutter = showNumbers
              ? `${chunkIndex === 0 ? String(lineIndex + 1).padStart(4, " ") : "    "} │ `
              : "";
            const used = leftPad + displayWidth(gutter) + displayWidth(chunk);
            rows.push({
              key: `md-${blockIndex}-code-${lineIndex}-${chunkIndex}`,
              node: (
                <Text wrap="truncate">
                  {margin}
                  <Text backgroundColor={background}>
                    {" ".repeat(leftPad)}
                    {showNumbers ? <Text color={theme.code.border}>{gutter}</Text> : null}
                    {highlightLine(chunk, block.language).map((token, tokenIndex) => (
                      <Text
                        key={`${lineIndex}-${chunkIndex}-${tokenIndex}`}
                        color={codeTokenColor(token.kind, theme)}
                      >
                        {token.text}
                      </Text>
                    ))}
                    {PANEL_PAD.repeat(Math.max(0, panelWidth - used))}
                    {PANEL_END}
                  </Text>
                </Text>
              ),
            });
          });
        });
        rows.push(paddingRow(`md-${blockIndex}-code-bottom`));
        break;
      }
      case "hr":
        rows.push({
          key: `md-${blockIndex}-hr`,
          node: (
            <Text color={theme.border.passive} wrap="truncate">
              {"─".repeat(Math.max(8, Math.min(safeWidth, 48)))}
            </Text>
          ),
        });
        break;
      case "table":
        rows.push(...tableRows(block, blockIndex, theme, safeWidth));
        break;
      case "task":
      case "bullet":
      case "numbered": {
        block.items.forEach((item, itemIndex) => {
          const checked = block.kind === "task" && "checked" in item ? item.checked : false;
          const prefix =
            block.kind === "task"
              ? `${"  ".repeat(item.indent)}${checked ? "● " : "○ "}`
              : block.kind === "numbered"
                ? `${"  ".repeat(item.indent)}${itemIndex + 1}. `
                : `${"  ".repeat(item.indent)}- `;
          const prefixWidth = displayWidth(prefix);
          const itemRows = wrapInlineSegments(
            parseInlineSegments(item.text),
            Math.max(1, safeWidth - prefixWidth),
          );
          itemRows.forEach((itemRow, rowIndex) => {
            rows.push({
              key: `md-${blockIndex}-${block.kind}-${itemIndex}-${rowIndex}`,
              node: (
                <Text wrap="truncate" color={theme.text}>
                  <Text color={theme.accent}>
                    {rowIndex === 0 ? prefix : " ".repeat(prefixWidth)}
                  </Text>
                  {inlineSegmentsNode(
                    itemRow,
                    theme,
                    `md-${blockIndex}-${block.kind}-${itemIndex}-${rowIndex}`,
                  )}
                </Text>
              ),
            });
          });
        });
        break;
      }
      case "quote": {
        block.lines.forEach((line, lineIndex) => {
          const quoteRows = wrapInlineSegments(
            parseInlineSegments(line),
            Math.max(1, safeWidth - 2),
          );
          quoteRows.forEach((quoteRow, rowIndex) => {
            rows.push({
              key: `md-${blockIndex}-quote-${lineIndex}-${rowIndex}`,
              node: (
                <Text wrap="truncate" color={theme.muted} italic>
                  <Text color={theme.border.passive}>
                    {rowIndex === 0 ? "▎ " : "  "}
                  </Text>
                  {inlineSegmentsNode(
                    quoteRow,
                    theme,
                    `md-${blockIndex}-quote-${lineIndex}-${rowIndex}`,
                    { textColor: theme.muted, textItalic: true, textDim: true },
                  )}
                </Text>
              ),
            });
          });
        });
        break;
      }
    }
  });

  return rows;
}

const lineEstimateCache = new Map<string, number>();

export function estimateMarkdownLines(content: string, width: number): number {
  const safeWidth = Math.max(12, width);
  const cacheKey = `${safeWidth}\u0000${content}`;
  const cached = lineEstimateCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const blocks = parseMarkdown(content);
  let lines = 0;
  for (const block of blocks) {
    if (block.kind === "heading" || block.kind === "paragraph") {
      const text = block.kind === "heading" ? block.text : block.lines.join("\n");
      lines += Math.max(1, wrapText(text, safeWidth).length);
    } else if (block.kind === "code") {
      const codeWidth = safeWidth >= 60 ? safeWidth - 10 : safeWidth - 3;
      lines += 2 + (block.language ? 1 : 0);
      for (const line of block.lines) {
        lines += Math.max(1, wrapPreservingWhitespace(line, Math.max(8, codeWidth)).length);
      }
    } else if (block.kind === "bullet" || block.kind === "task" || block.kind === "numbered") {
      for (const item of block.items) {
        const prefix = 2 + item.indent * 2;
        lines += Math.max(1, wrapText(item.text, Math.max(8, safeWidth - prefix)).length);
      }
    } else if (block.kind === "quote") {
      for (const line of block.lines) {
        lines += Math.max(1, wrapText(line, Math.max(8, safeWidth - 2)).length);
      }
    } else if (block.kind === "table") {
      lines += safeWidth < 30 ? Math.max(1, block.rows.length) : 2 + block.rows.length;
    } else {
      lines += 1;
    }
  }
  lines += Math.max(0, blocks.length - 1);
  const result = Math.max(1, lines);
  if (lineEstimateCache.size > 300) lineEstimateCache.clear();
  lineEstimateCache.set(cacheKey, result);
  return result;
}

export function MarkdownView({
  content,
  width = 80,
  theme = getTheme("tokyonight"),
}: MarkdownViewProps): React.ReactElement {
  const blocks = React.useMemo(() => parseMarkdown(content), [content]);
  const safeWidth = Math.max(12, width);

  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return (
              <Text key={index} bold color={block.level === 1 ? theme.accent : theme.text}>
                {renderInline(block.text, theme)}
              </Text>
            );
          case "code": {
            const showNumbers = safeWidth >= 60;
            const gutter = showNumbers ? 4 : 0;
            const codeWidth = Math.max(8, safeWidth - gutter - 4);
            return (
              <Box key={index} flexDirection="column" paddingX={1}>
                <Text backgroundColor={theme.code.background}> </Text>
                {block.language ? (
                  <Text color={theme.syntax.type} bold backgroundColor={theme.code.background}>
                    {block.language}
                  </Text>
                ) : null}
                {block.lines.flatMap((line, lineIndex) =>
                  wrapPreservingWhitespace(line, codeWidth).map((chunk, chunkIndex) => (
                    <Text
                      key={`${lineIndex}-${chunkIndex}`}
                      backgroundColor={theme.code.background}
                    >
                      <Text color={theme.border.passive}>▎ </Text>
                      {showNumbers ? (
                        <Text color={theme.muted}>
                          {chunkIndex === 0 ? `${String(lineIndex + 1).padStart(3, " ")} | ` : "    | "}
                        </Text>
                      ) : null}
                      {highlightLine(chunk, block.language).map((token, tokenIndex) => (
                        <Text key={tokenIndex} color={codeTokenColor(token.kind, theme)}>
                          {token.text}
                        </Text>
                      ))}
                    </Text>
                  )),
                )}
                <Text backgroundColor={theme.code.background}> </Text>
              </Box>
            );
          }
          case "hr":
            return (
              <Text key={index} color={theme.border.passive}>
                {"─".repeat(Math.max(8, Math.min(safeWidth, 48)))}
              </Text>
            );
          case "table":
            return renderTable(block, index, theme, safeWidth);
          case "task":
            return (
              <Box key={index} flexDirection="column">
                {block.items.map((item, itemIndex) => (
                  <Box key={itemIndex} flexDirection="row">
                    <Text color={item.checked ? theme.accent : theme.muted}>
                      {`${"  ".repeat(item.indent)}${item.checked ? "● " : "○ "}`}
                    </Text>
                    <Box flexDirection="column" flexShrink={1}>
                      <Text color={theme.text}>{renderInline(item.text, theme)}</Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            );
          case "bullet":
            return (
              <Box key={index} flexDirection="column">
                {block.items.map((item, itemIndex) => (
                  <Box key={itemIndex} flexDirection="row">
                    <Text color={theme.accent}>{`${"  ".repeat(item.indent)}- `}</Text>
                    <Box flexDirection="column" flexShrink={1}>
                      <Text color={theme.text}>{renderInline(item.text, theme)}</Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            );
          case "numbered":
            return (
              <Box key={index} flexDirection="column">
                {block.items.map((item, itemIndex) => (
                  <Box key={itemIndex} flexDirection="row">
                    <Text color={theme.accent}>
                      {`${"  ".repeat(item.indent)}${itemIndex + 1}. `}
                    </Text>
                    <Box flexDirection="column" flexShrink={1}>
                      <Text color={theme.text}>{renderInline(item.text, theme)}</Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            );
          case "quote":
            return (
              <Box key={index} flexDirection="column">
                {block.lines.map((line, lineIndex) => (
                  <Box key={lineIndex} flexDirection="row">
                    <Text color={theme.border.passive}>▎ </Text>
                    <Box flexDirection="column" flexShrink={1}>
                      <Text color={theme.muted} italic>
                        {renderInline(line, theme)}
                      </Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            );
          default:
            return (
              <Box key={index} flexDirection="column">
                {block.lines.map((line, lineIndex) => (
                  <Text key={lineIndex} color={theme.text}>
                    {renderInline(line, theme)}
                  </Text>
                ))}
              </Box>
            );
        }
      })}
    </Box>
  );
}
