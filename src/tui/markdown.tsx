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
  | { kind: "bullet"; items: string[] }
  | { kind: "numbered"; items: string[] }
  | { kind: "quote"; lines: string[] }
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

export function parseMarkdown(content: string): MarkdownBlock[] {
  const lines = content.split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const language = fence[1].trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language, lines: codeLines });
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

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ""));
        index += 1;
      }
      blocks.push({ kind: "bullet", items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ""));
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
      !/^```/.test(lines[index]) &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*[-*+]\s+/.test(lines[index]) &&
      !/^\s*\d+[.)]\s+/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

export function highlightLine(line: string, language: string): HighlightToken[] {
  const normalized = normalizeLanguage(language);
  const keywords = new Set(LANGUAGE_KEYWORDS[normalized] ?? LANGUAGE_KEYWORDS.typescript);
  const commentStart = normalized === "python" || normalized === "bash" ? "#" : "//";
  const tokens: HighlightToken[] = [];
  const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/.*$|#.*$)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;

  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > cursor) tokens.push({ kind: "text", text: line.slice(cursor, match.index) });
    const [full, stringPart, commentPart, numberPart, wordPart] = match;
    if (stringPart !== undefined) tokens.push({ kind: "string", text: full });
    else if (commentPart !== undefined) {
      tokens.push({ kind: "comment", text: commentPart.startsWith(commentStart) ? full : full });
    } else if (numberPart !== undefined) tokens.push({ kind: "number", text: full });
    else if (wordPart !== undefined) {
      tokens.push({ kind: keywords.has(wordPart) ? "keyword" : "text", text: full });
    }
    cursor = match.index + full.length;
  }
  if (cursor < line.length) tokens.push({ kind: "text", text: line.slice(cursor) });
  return tokens;
}

const FILE_REFERENCE = /(?:^|[\s("'[])((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|json|md|ya?ml|toml|sh))(?::(\d+))?/g;

export function renderInline(text: string, theme: Theme): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const rest = text.slice(cursor);
    const inlineCode = /^`([^`]+)`/.exec(rest);
    const bold = /^\*\*([^*]+)\*\*/.exec(rest);
    const fileRef = FILE_REFERENCE.exec(rest);
    const candidates = [
      inlineCode ? { index: inlineCode.index, kind: "code", match: inlineCode } : undefined,
      bold ? { index: bold.index, kind: "bold", match: bold } : undefined,
      fileRef ? { index: fileRef.index, kind: "file", match: fileRef } : undefined,
    ].filter((entry): entry is { index: number; kind: string; match: RegExpExecArray } => entry !== undefined);

    if (candidates.length === 0) {
      nodes.push(rest);
      break;
    }
    candidates.sort((left, right) => left.index - right.index);
    const winner = candidates[0];
    if (winner.index > 0) nodes.push(rest.slice(0, winner.index));

    if (winner.kind === "code") {
      nodes.push(
        <Text key={`${cursor}-code`} color={theme.syntax.string}>
          {winner.match[1]}
        </Text>,
      );
      cursor += winner.index + winner.match[0].length;
    } else if (winner.kind === "bold") {
      nodes.push(
        <Text key={`${cursor}-bold`} bold>
          {winner.match[1]}
        </Text>,
      );
      cursor += winner.index + winner.match[0].length;
    } else {
      const marker = winner.match[2] ? `:${winner.match[2]}` : "";
      nodes.push(
        <Text key={`${cursor}-file`} color={theme.modes.plan.primary} bold>
          {`${winner.match[1]}${marker}`}
        </Text>,
      );
      cursor += winner.index + winner.match[0].length;
    }
    FILE_REFERENCE.lastIndex = 0;
  }
  return nodes;
}

export function MarkdownView({ content, theme = getTheme("tokyonight") }: MarkdownViewProps): React.ReactElement {
  const blocks = React.useMemo(() => parseMarkdown(content), [content]);
  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return (
              <Text key={index} bold color={theme.accent}>
                {block.level === 1 ? "" : block.level === 2 ? "  " : "    "}
                {block.text}
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
          case "bullet":
            return (
              <Box key={index} flexDirection="column">
                {block.items.map((item, itemIndex) => (
                  <Text key={itemIndex}>
                    <Text color={theme.accent}>- </Text>
                    {renderInline(item, theme)}
                  </Text>
                ))}
              </Box>
            );
          case "numbered":
            return (
              <Box key={index} flexDirection="column">
                {block.items.map((item, itemIndex) => (
                  <Text key={itemIndex}>
                    <Text color={theme.accent}>{`${itemIndex + 1}. `}</Text>
                    {renderInline(item, theme)}
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
                {renderInline(block.lines.join(" "), theme)}
              </Text>
            );
        }
      })}
    </Box>
  );
}
