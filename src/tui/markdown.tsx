import React from "react";
import { Box, Text } from "ink";
import type { Token } from "marked";
import { DEFAULT_UI_LAYOUT, type UiLayout } from "../types/ui-layout";
import type { RenderRow } from "./rows";
import { displayWidth, graphemeClusters, wrapPreservingWhitespace } from "./text-wrap";
import { getTheme, useActiveTheme, type Theme } from "./theme";
import { parseInlineSegments, parseMarkdown, pushInlineSegment,
  type InlineSegment, type MarkdownBlock } from "./markdown-parser";

export { decodeEntities, inlinePlainText, normalizeHtml, parseMarkdown, type MarkdownBlock } from "./markdown-parser";

export interface MarkdownViewProps { content: string; width?: number; theme?: Theme }
export type TokenKind = "keyword" | "string" | "comment" | "number" | "type" | "text";
export interface HighlightToken { kind: TokenKind; text: string }

interface MarkdownStyle {
  tables: "grid" | "ruled" | "plain";
  code: "fence" | "rail" | "panel" | "indent";
  bullet: string;
  tasks: [unchecked: string, checked: string];
  showHeadingMarkers?: boolean;
  tight?: boolean;
}

const MARKDOWN_STYLES: Record<UiLayout, MarkdownStyle> = {
  orchivox: { tables: "grid", code: "fence", bullet: "- ", tasks: ["○ ", "● "] },
  reading: { tables: "ruled", code: "rail", bullet: "• ", tasks: ["[ ] ", "[x] "] },
  review: { tables: "ruled", code: "panel", bullet: "- ", tasks: ["[ ] ", "[x] "], showHeadingMarkers: true },
  compact: { tables: "plain", code: "indent", bullet: "- ", tasks: ["[ ] ", "[x] "], tight: true },
};

const LANGUAGE_KEYWORDS: Record<string, string[]> = {
  typescript: ["const", "let", "var", "function", "class", "interface", "type", "enum", "return", "if", "else", "for", "while", "import", "from", "export", "default", "async", "await", "new", "try", "catch", "finally", "throw", "extends", "implements", "typeof", "instanceof", "null", "undefined", "true", "false", "void", "this", "as", "of", "in"],
  python: ["def", "class", "return", "if", "elif", "else", "for", "while", "import", "from", "as", "with", "try", "except", "finally", "raise", "None", "True", "False", "async", "await", "lambda", "pass", "yield", "global", "assert", "self", "in", "is", "not", "and", "or"],
  go: ["func", "package", "import", "type", "struct", "interface", "return", "if", "else", "for", "range", "go", "defer", "chan", "select", "switch", "case", "default", "var", "const", "map", "nil", "true", "false", "break", "continue"],
  rust: ["fn", "let", "mut", "struct", "enum", "impl", "trait", "use", "pub", "mod", "match", "if", "else", "for", "while", "loop", "return", "async", "await", "move", "ref", "self", "Self", "true", "false", "crate", "super", "where", "dyn", "unsafe", "const", "static"],
  json: ["true", "false", "null"],
  bash: ["if", "then", "else", "elif", "fi", "for", "do", "done", "while", "case", "esac", "function", "local", "export", "return", "echo", "cd", "set", "shift", "exit", "read"],
};
const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", golang: "go", rs: "rust", sh: "bash", shell: "bash", zsh: "bash",
};

export function normalizeLanguage(language: string): string {
  const lower = language.trim().toLowerCase();
  return LANGUAGE_ALIASES[lower] ?? lower;
}

export function highlightLine(line: string, language: string): HighlightToken[] {
  const normalized = normalizeLanguage(language);
  const words = LANGUAGE_KEYWORDS[normalized === "javascript" ? "typescript" : normalized];
  if (!words) return [{ kind: "text", text: line }];
  const keywords = new Set(words);
  const tokens: HighlightToken[] = [];
  const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/.*$|#.*$)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > cursor) tokens.push({ kind: "text", text: line.slice(cursor, match.index) });
    const [text, string, comment, number] = match;
    tokens.push({ text, kind: string !== undefined ? "string" : comment !== undefined ? "comment" :
      number !== undefined ? "number" : keywords.has(text) ? "keyword" : "text" });
    cursor = match.index + text.length;
  }
  if (cursor < line.length) tokens.push({ kind: "text", text: line.slice(cursor) });
  return tokens;
}

interface InlineStyle { color?: string; bold?: boolean; italic?: boolean }

function inlineNode(segments: InlineSegment[], theme: Theme, style: InlineStyle = {}): React.ReactNode[] {
  return segments.map((segment, index) => <Text key={index}
    color={segment.kind === "code" ? theme.syntax.string : segment.kind === "url" ? theme.muted :
      segment.kind === "file" || segment.kind === "link" ? theme.accent : style.color ?? theme.text}
    bold={segment.bold || segment.kind === "file" || style.bold || undefined}
    italic={segment.italic || style.italic || undefined}
    strikethrough={segment.strike} underline={segment.kind === "link"}>
    {segment.text}
  </Text>);
}

export function renderInline(text: string, theme: Theme): React.ReactNode[] {
  return inlineNode(parseInlineSegments(text), theme);
}

function wrapInlineSegments(segments: InlineSegment[], width: number): InlineSegment[][] {
  const rows: InlineSegment[][] = [];
  let row: InlineSegment[] = [];
  let used = 0;
  const append = (segment: InlineSegment, text: string): void => {
    pushInlineSegment(row, { ...segment, text });
    used += displayWidth(text);
  };
  const flush = (): void => {
    while (row.length > 0) {
      const last = row[row.length - 1];
      last.text = last.text.replace(/\s+$/, "");
      if (last.text) break;
      row.pop();
    }
    rows.push(row); row = []; used = 0;
  };
  const limit = Math.max(1, width);
  for (const segment of segments) {
    for (const word of segment.text.match(/\n|[^\S\n]+|[^\s]+/g) ?? []) {
      if (word === "\n") { flush(); continue; }
      const whitespace = /^\s+$/.test(word);
      const size = displayWidth(word);
      if (whitespace && used === 0) continue;
      if (used + size <= limit) { append(segment, word); continue; }
      if (whitespace) { flush(); continue; }
      if (size <= limit) { flush(); append(segment, word); continue; }
      for (const cluster of graphemeClusters(word)) {
        if (used > 0 && used + displayWidth(cluster) > limit) flush();
        append(segment, cluster);
      }
    }
  }
  if (row.length > 0 || rows.length === 0) flush();
  return rows;
}

function inlineRows(source: string | readonly Token[], width: number, theme: Theme, key: string,
  style: InlineStyle = {}): RenderRow[] {
  return wrapInlineSegments(parseInlineSegments(source), width).map((segments, index) => ({
    key: key + "-" + index,
    node: <Text wrap="truncate" color={style.color ?? theme.text} bold={style.bold} italic={style.italic}>
      {segments.length > 0 ? inlineNode(segments, theme, style) : " "}
    </Text>,
  }));
}

function tableRows(block: Extract<MarkdownBlock, { kind: "table" }>, width: number, theme: Theme,
  key: string, style: MarkdownStyle["tables"]): RenderRow[] {
  const count = block.headers.length;
  if (count === 0) return [];
  const grid = style === "grid";
  const gap = style === "plain" ? "  " : " │ ";
  const natural = Array<number>(count).fill(1);
  const sourceRows = [block.headers, ...block.rows].map((cells) => block.headers.map((_, column) => {
    const segments = parseInlineSegments(cells[column]?.tokens ?? []);
    for (const line of segments.map((segment) => segment.text).join("").split("\n")) {
      natural[column] = Math.max(natural[column], displayWidth(line));
    }
    return segments;
  }));
  const widths = natural.map((value) => Math.min(6, value));
  const separatorWidth = (count - 1) * displayWidth(gap) + (grid ? 4 : 0);
  let remaining = width - separatorWidth - widths.reduce((sum, value) => sum + value, 0);
  const rows: RenderRow[] = [];
  if (remaining < 0) {
    if (grid && width >= 6) {
      const cellWidth = width - 4;
      const border = (left: string, right: string) => left + "─".repeat(cellWidth + 2) + right;
      (block.rows.length ? block.rows : [[]]).forEach((cells, rowIndex) => {
        rows.push({ key: key + "-top-" + rowIndex, node: <Text color={theme.muted}>{border("┌", "┐")}</Text> });
        block.headers.forEach((header, column) => {
          const segments = [
            ...parseInlineSegments(header.tokens).map((segment) => ({ ...segment, bold: true })),
            { kind: "text" as const, text: "\n" },
            ...parseInlineSegments(cells[column]?.tokens ?? []),
          ];
          wrapInlineSegments(segments, cellWidth).forEach((line, lineIndex) => {
            const spare = Math.max(0, cellWidth - line.reduce((sum, segment) => sum + displayWidth(segment.text), 0));
            rows.push({ key: `${key}-stack-${rowIndex}-${column}-${lineIndex}`, node: <Text color={theme.text} wrap="truncate">
              <Text color={theme.muted}>│ </Text>{inlineNode(line, theme)}{" ".repeat(spare)}<Text color={theme.muted}> │</Text>
            </Text> });
          });
          if (column + 1 < count) rows.push({ key: `${key}-stack-separator-${rowIndex}-${column}`, node: <Text color={theme.muted}>{border("├", "┤")}</Text> });
        });
        rows.push({ key: key + "-bottom-" + rowIndex, node: <Text color={theme.muted}>{border("└", "┘")}</Text> });
      });
      return rows;
    }
    block.rows.forEach((cells, rowIndex) => {
      if (rowIndex > 0) rows.push({ key: key + "-gap-" + rowIndex, node: <Text> </Text> });
      block.headers.forEach((header, column) => {
        rows.push(...inlineRows(header.tokens, width, theme, key + "-label-" + rowIndex + "-" + column, { bold: true }));
        rows.push(...inlineRows(cells[column]?.tokens ?? [], Math.max(1, width - 2), theme,
          key + "-value-" + rowIndex + "-" + column).map((row) => ({ ...row,
            node: <Text wrap="truncate">{"  "}{row.node}</Text> })));
      });
    });
    if (block.rows.length === 0) {
      for (const [index, header] of block.headers.entries()) rows.push(...inlineRows(header.tokens, width, theme, key + "-empty-" + index, { bold: true }));
    }
    return rows;
  }
  while (remaining > 0) {
    let column = -1;
    for (let index = 0; index < count; index++) {
      if (natural[index] > widths[index] && (column < 0 || natural[index] - widths[index] > natural[column] - widths[column])) column = index;
    }
    if (column < 0) break;
    widths[column]++; remaining--;
  }
  const border = (left: string, middle: string, right: string): string =>
    left + widths.map((value) => "─".repeat(value + 2)).join(middle) + right;
  if (grid) rows.push({ key: key + "-top", node: <Text color={theme.muted}>{border("┌", "┬", "┐")}</Text> });
  sourceRows.forEach((cells, rowIndex) => {
    const wrapped = widths.map((cellWidth, column) => wrapInlineSegments(cells[column], cellWidth));
    const height = Math.max(1, ...wrapped.map((lines) => lines.length));
    for (let line = 0; line < height; line++) {
      const parts: React.ReactNode[] = grid ? [<Text key="left" color={theme.muted}>│ </Text>] : [];
      for (let column = 0; column < count; column++) {
        const segments = wrapped[column][line] ?? [];
        const spare = Math.max(0, widths[column] - segments.reduce((sum, segment) => sum + displayWidth(segment.text), 0));
        const align = block.align[column];
        const left = align === "right" ? spare : align === "center" ? Math.floor(spare / 2) : 0;
        parts.push(<Text key={column} bold={rowIndex === 0} color={theme.text}>
          {" ".repeat(left)}{inlineNode(segments, theme, { bold: rowIndex === 0 })}{" ".repeat(spare - left)}
          <Text color={theme.muted}>{column + 1 < count ? gap : grid ? " │" : ""}</Text>
        </Text>);
      }
      rows.push({ key: key + "-" + rowIndex + "-" + line, node: <Text wrap="truncate">{parts}</Text> });
    }
    const last = rowIndex === sourceRows.length - 1;
    if (grid || rowIndex === 0) {
      const rule = grid ? (last ? border("└", "┴", "┘") : border("├", "┼", "┤"))
        : widths.map((cellWidth) => "─".repeat(cellWidth)).join(style === "plain" ? gap : "─┼─");
      rows.push({ key: key + "-separator-" + rowIndex, node: <Text color={theme.muted} wrap="truncate">{rule}</Text> });
    }
  });
  return rows;
}

function codeRows(block: Extract<MarkdownBlock, { kind: "code" }>, width: number, theme: Theme, key: string,
  frame: MarkdownStyle["code"], streaming: boolean): RenderRow[] {
  const fence = "```";
  const label = frame === "fence" ? fence + block.language : block.language;
  const inset = frame === "rail" && width >= 4 ? "│ " : " ".repeat(Math.min(2, Math.max(0, width - 2)));
  const bodyWidth = Math.max(1, width - displayWidth(inset));
  const background = frame === "panel" ? theme.code.background : undefined;
  const rows: RenderRow[] = [];
  if (label) rows.push({ key: key + "-start", node: <Text color={theme.muted} wrap="truncate">{label}</Text> });
  block.lines.forEach((line, lineIndex) => {
    wrapPreservingWhitespace(line, bodyWidth).forEach((chunk, chunkIndex) => {
      const padding = background ? " ".repeat(Math.max(0, bodyWidth - displayWidth(chunk || " "))) : "";
      rows.push({
        key: key + "-" + lineIndex + "-" + chunkIndex,
        node: <Text wrap="truncate" backgroundColor={background}>
          <Text color={theme.muted}>{inset}</Text>
          {chunk ? highlightLine(chunk, block.language).map((token, tokenIndex) =>
            <Text key={tokenIndex} color={token.kind === "text" ? theme.text : theme.syntax[token.kind]}>{token.text}</Text>) : " "}
          {padding}
        </Text>,
      });
    });
  });
  if (frame === "fence" && !(streaming && block.openFence)) {
    rows.push({ key: key + "-end", node: <Text color={theme.muted} wrap="truncate">{fence}</Text> });
  }
  return rows;
}

function renderBlocks(blocks: MarkdownBlock[], width: number, theme: Theme, key: string,
  style: MarkdownStyle, streaming: boolean, tight = false): RenderRow[] {
  const rows: RenderRow[] = [];
  const safeWidth = Math.max(1, width);
  blocks.forEach((block, index) => {
    const prefix = key + "-" + index;
    if (rows.length > 0 && !tight && !style.tight && !(blocks[index - 1].kind === "paragraph" && block.kind === "list")) {
      rows.push({ key: prefix + "-gap", node: <Text> </Text> });
    }
    switch (block.kind) {
      case "heading": {
        const marker = "#".repeat(block.level) + " ";
        const tokens: Token[] = style.showHeadingMarkers ? [{ type: "text", raw: marker, text: marker }, ...block.tokens] : block.tokens;
        rows.push(...inlineRows(tokens, safeWidth, theme, prefix + "-heading",
          { bold: true, color: block.level === 1 ? theme.accent : theme.text }));
        break;
      }
      case "paragraph": rows.push(...inlineRows(block.tokens, safeWidth, theme, prefix + "-paragraph")); break;
      case "code":
        rows.push(...codeRows(block, safeWidth, theme, prefix + "-code", style.code, streaming));
        break;
      case "hr": rows.push({ key: prefix + "-hr", node: <Text color={theme.muted}>{"─".repeat(safeWidth)}</Text> }); break;
      case "table": rows.push(...tableRows(block, safeWidth, theme, prefix + "-table", style.tables)); break;
      case "list": {
        block.items.forEach((item, itemIndex) => {
          if (itemIndex > 0 && block.loose && !style.tight) rows.push({ key: prefix + "-item-gap-" + itemIndex, node: <Text> </Text> });
          const marker = item.checked !== undefined ? style.tasks[item.checked ? 1 : 0] : block.ordered ? String(block.start + itemIndex) + ". " : style.bullet;
          const itemRows = renderBlocks(item.blocks, Math.max(1, safeWidth - displayWidth(marker)), theme,
            prefix + "-item-" + itemIndex, style, streaming, !block.loose);
          if (itemRows.length === 0) itemRows.push({ key: prefix + "-empty-" + itemIndex, node: <Text> </Text> });
          itemRows.forEach((row, lineIndex) => rows.push({ ...row, node: <Text wrap="truncate">
            <Text color={theme.muted}>{lineIndex === 0 ? marker : " ".repeat(displayWidth(marker))}</Text>{row.node}
          </Text> }));
        });
        break;
      }
      case "quote": {
        const children = renderBlocks(block.blocks, Math.max(1, safeWidth - 2), { ...theme, text: theme.muted }, prefix + "-quote", style, streaming);
        for (const row of children) rows.push({ ...row, node: <Text color={theme.muted} wrap="truncate">
          │ {row.node}
        </Text> });
        break;
      }
    }
  });
  return rows;
}

export function markdownRows(content: string, width: number, theme: Theme,
  { layout = DEFAULT_UI_LAYOUT, streaming = false }: { layout?: UiLayout; streaming?: boolean } = {}): RenderRow[] {
  return renderBlocks(parseMarkdown(content), width, theme, "md", MARKDOWN_STYLES[layout], streaming);
}

const lineEstimateCache = new Map<string, number>();
export function estimateMarkdownLines(content: string, width: number): number {
  const key = width + "\u0000" + content;
  const cached = lineEstimateCache.get(key);
  if (cached !== undefined) return cached;
  const count = Math.max(1, markdownRows(content, width, getTheme("tokyonight")).length);
  if (lineEstimateCache.size >= 128) lineEstimateCache.clear();
  lineEstimateCache.set(key, count);
  return count;
}

export function MarkdownView({ content, width = 80, theme: themeProp }: MarkdownViewProps): React.ReactElement {
  const theme = useActiveTheme(themeProp);
  const rows = React.useMemo(() => markdownRows(content, width, theme), [content, width, theme]);
  return <Box flexDirection="column">{rows.map((row) => <React.Fragment key={row.key}>{row.node}</React.Fragment>)}</Box>;
}
