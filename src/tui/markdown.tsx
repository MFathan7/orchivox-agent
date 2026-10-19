import React from "react";
import { Box, Text } from "ink";

import { getTheme, type Theme } from "./theme";

export interface MarkdownViewProps {
  content: string;
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
  return output.join("\n");
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

function truncateCell(value: string, width: number): string {
  const text = value.trim();
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

function padCell(value: string, width: number): string {
  return truncateCell(value, width).padEnd(width);
}

function renderTable(block: Extract<MarkdownBlock, { kind: "table" }>, index: number, theme: Theme): React.ReactElement {
  const columnCount = Math.max(
    block.headers.length,
    ...block.rows.map((row) => row.length),
    0,
  );
  const widths = Array.from({ length: columnCount }, (_, column) => {
    const values = [block.headers[column] ?? "", ...block.rows.map((row) => row[column] ?? "")];
    return Math.min(28, Math.max(3, ...values.map((value) => value.length)));
  });

  return (
    <Box key={index} flexDirection="column">
      <Text>
        {Array.from({ length: columnCount }, (_, column) => (
          <Text key={`head-${column}`} bold color={theme.accent}>
            {padCell(block.headers[column] ?? "", widths[column])}
            {column < columnCount - 1 ? " │ " : ""}
          </Text>
        ))}
      </Text>
      <Text color={theme.border.passive}>
        {widths.map((width) => "─".repeat(width)).join("─┼─")}
      </Text>
      {block.rows.map((row, rowIndex) => (
        <Text key={`row-${rowIndex}`}>
          {Array.from({ length: columnCount }, (_, column) => (
            <Text key={`cell-${rowIndex}-${column}`} color={theme.text}>
              {padCell(row[column] ?? "", widths[column])}
              {column < columnCount - 1 ? " │ " : ""}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

export function MarkdownView({ content, theme = getTheme("tokyonight") }: MarkdownViewProps): React.ReactElement {
  const blocks = React.useMemo(() => parseMarkdown(content), [content]);
  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return (
              <Text key={index} bold color={block.level === 1 ? theme.accent : theme.text}>
                {block.level === 1 ? "" : block.level === 2 ? "  " : "    "}
                {renderInline(block.text, theme)}
              </Text>
            );
          case "code":
            return (
              <Box key={index} flexDirection="column" borderStyle="round" borderColor={theme.border.active} paddingX={1}>
                <Text color={theme.syntax.type} bold>
                  {block.language || "code"}
                </Text>
                {block.lines.map((line, lineIndex) => (
                  <Text key={lineIndex}>
                    <Text color={theme.muted}>{String(lineIndex + 1).padStart(3, " ")} | </Text>
                    {highlightLine(line, block.language).map((token, tokenIndex) => (
                      <Text
                        key={tokenIndex}
                        color={
                          token.kind === "keyword"
                            ? theme.syntax.keyword
                            : token.kind === "string"
                              ? theme.syntax.string
                              : token.kind === "comment"
                                ? theme.syntax.comment
                                : token.kind === "number"
                                  ? theme.syntax.number
                                  : theme.text
                        }
                      >
                        {token.text}
                      </Text>
                    ))}
                  </Text>
                ))}
              </Box>
            );
          case "hr":
            return (
              <Text key={index} color={theme.border.passive}>
                {"─".repeat(24)}
              </Text>
            );
          case "table":
            return renderTable(block, index, theme);
          case "task":
            return (
              <Box key={index} flexDirection="column">
                {block.items.map((item, itemIndex) => (
                  <Text key={itemIndex}>
                    <Text color={item.checked ? theme.accent : theme.muted}>
                      {`${"  ".repeat(item.indent)}${item.checked ? "● " : "○ "}`}
                    </Text>
                    {renderInline(item.text, theme)}
                  </Text>
                ))}
              </Box>
            );
          case "bullet":
            return (
              <Box key={index} flexDirection="column">
                {block.items.map((item, itemIndex) => (
                  <Text key={itemIndex}>
                    <Text color={theme.accent}>{`${"  ".repeat(item.indent)}- `}</Text>
                    {renderInline(item.text, theme)}
                  </Text>
                ))}
              </Box>
            );
          case "numbered":
            return (
              <Box key={index} flexDirection="column">
                {block.items.map((item, itemIndex) => (
                  <Text key={itemIndex}>
                    <Text color={theme.accent}>{`${"  ".repeat(item.indent)}${itemIndex + 1}. `}</Text>
                    {renderInline(item.text, theme)}
                  </Text>
                ))}
              </Box>
            );
          case "quote":
            return (
              <Box key={index} flexDirection="column" borderStyle="single" borderColor={theme.border.passive} paddingX={1}>
                {block.lines.map((line, lineIndex) => (
                  <Text key={lineIndex} color={theme.muted} italic>
                    {renderInline(line, theme)}
                  </Text>
                ))}
              </Box>
            );
          default:
            return (
              <Text key={index} color={theme.text}>
                {renderInline(block.lines.join("\n"), theme)}
              </Text>
            );
        }
      })}
    </Box>
  );
}
