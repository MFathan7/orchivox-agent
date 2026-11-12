import { Lexer, type Token, type Tokens } from "marked";
import { expandTabs } from "./text-wrap";

export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string; tokens: Token[] }
  | { kind: "paragraph"; tokens: Token[] }
  | { kind: "code"; language: string; lines: string[] }
  | { kind: "list"; ordered: boolean; start: number; loose: boolean; items: Array<{ checked?: boolean; blocks: MarkdownBlock[] }> }
  | { kind: "quote"; blocks: MarkdownBlock[] }
  | { kind: "table"; headers: Tokens.TableCell[]; rows: Tokens.TableCell[][]; align: Array<"left" | "center" | "right" | null> }
  | { kind: "hr" };

export interface InlineSegment {
  kind: "text" | "code" | "link" | "url" | "file";
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
}

const lexerOptions = { gfm: true, breaks: false };
const FILE_REFERENCE = /((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|json|md|ya?ml|toml|sh))(?::(\d+))?/g;
const HTML_TAG = /<\/?(?:br|p|div|span|strong|b|em|i|code|pre|li|ul|ol|table|thead|tbody|tr|td|th|h[1-6]|blockquote|a|hr|details|summary|img)\b[^>]*>/gi;

function safeCodePoint(value: number): string {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
}

export function decodeEntities(text: string): string {
  return text.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, value: string) => safeCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_match, value: string) => safeCodePoint(Number(value)));
}

function htmlLineToText(line: string): string {
  return decodeEntities(line
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<img\b[^>]*alt\s*=\s*["']([^"']*)["'][^>]*\/?>/gi, "[image: $1]")
    .replace(/<br\s*\/?>/gi, "  \n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|details|summary)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<(strong|b)\b[^>]*>/gi, "**").replace(/<\/(strong|b)>/gi, "**")
    .replace(/<(em|i)\b[^>]*>/gi, "*").replace(/<\/(em|i)>/gi, "*")
    .replace(/<code\b[^>]*>/gi, "`").replace(/<\/code>/gi, "`")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    .replace(HTML_TAG, ""));
}

export function normalizeHtml(content: string): string {
  return Lexer.lex(expandTabs(content), lexerOptions).map((token) => {
    if (token.type === "code") return token.raw;
    if (token.type === "html") return htmlLineToText(token.raw);
    return token.raw;
  }).join("");
}

function blocksFromTokens(tokens: readonly Token[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
      case "checkbox":
      case "def": break;
      case "heading": {
        const value = token as Tokens.Heading;
        blocks.push({ kind: "heading", level: value.depth, text: value.text, tokens: value.tokens });
        break;
      }
      case "code": {
        const value = token as Tokens.Code;
        blocks.push({ kind: "code", language: value.lang?.trim().split(/\s+/)[0] ?? "", lines: value.text.split("\n") });
        break;
      }
      case "list": {
        const value = token as Tokens.List;
        blocks.push({ kind: "list", ordered: value.ordered, start: typeof value.start === "number" ? value.start : 1,
          loose: value.loose, items: value.items.map((item) => ({
            checked: item.task ? item.checked : undefined, blocks: blocksFromTokens(item.tokens),
          })),
        });
        break;
      }
      case "blockquote":
        blocks.push({ kind: "quote", blocks: blocksFromTokens((token as Tokens.Blockquote).tokens) });
        break;
      case "table": {
        const value = token as Tokens.Table;
        blocks.push({ kind: "table", headers: value.header, rows: value.rows, align: value.align });
        break;
      }
      case "hr": blocks.push({ kind: "hr" }); break;
      case "html": {
        const normalized = htmlLineToText(token.raw);
        if (normalized.trim().length === 0) break;
        if (normalized !== token.raw) blocks.push(...blocksFromTokens(Lexer.lex(normalized, lexerOptions)));
        else blocks.push({ kind: "paragraph", tokens: [{ type: "text", raw: token.raw, text: token.raw }] });
        break;
      }
      default: {
        const value = token as Tokens.Paragraph | Tokens.Text;
        blocks.push({ kind: "paragraph", tokens: value.tokens ?? Lexer.lexInline(value.text ?? value.raw, lexerOptions) });
      }
    }
  }
  return blocks;
}

export function parseMarkdown(content: string): MarkdownBlock[] {
  return blocksFromTokens(Lexer.lex(expandTabs(content), lexerOptions));
}

export function pushInlineSegment(segments: InlineSegment[], segment: InlineSegment): void {
  if (segment.text.length === 0) return;
  const previous = segments.at(-1);
  if (previous && previous.kind === segment.kind && previous.bold === segment.bold &&
      previous.italic === segment.italic && previous.strike === segment.strike) previous.text += segment.text;
  else segments.push({ ...segment });
}

export function parseInlineSegments(source: string | readonly Token[]): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const walk = (tokens: readonly Token[], inherited: Omit<InlineSegment, "text">): void => {
    let style = { ...inherited };
    const htmlStack: Array<{ tag: string; style: typeof style }> = [];
    let htmlLink: { href: string; start: number; style: typeof style } | undefined;
    for (const token of tokens) {
      const value = token as Tokens.Text;
      const append = (text: string, kind = style.kind): void => pushInlineSegment(segments, { ...style, kind, text });
      switch (token.type) {
        case "strong": walk((token as Tokens.Strong).tokens, { ...style, bold: true }); break;
        case "em": walk((token as Tokens.Em).tokens, { ...style, italic: true }); break;
        case "del": walk((token as Tokens.Del).tokens, { ...style, strike: true }); break;
        case "codespan": append((token as Tokens.Codespan).text, "code"); break;
        case "br": append("\n"); break;
        case "link": {
          const link = token as Tokens.Link;
          walk(link.tokens, { ...style, kind: "link" });
          const href = expandTabs(decodeEntities(link.href));
          const label = expandTabs(decodeEntities(link.text));
          if (href && label !== href && label !== href.replace(/^mailto:/, "")) {
            append(" ("); append(href, "url"); append(")");
          }
          break;
        }
        case "image": append("[image: " + (token as Tokens.Image).text + "]"); break;
        case "html": {
          const tag = /^<(\/?)([a-z0-9]+)\b/i.exec(token.raw);
          if (!tag) break;
          const name = tag[2].toLowerCase();
          if (name === "br") { append("\n"); break; }
          if (name === "a") {
            if (tag[1] && htmlLink) {
              const label = segments.map((segment) => segment.text).join("").slice(htmlLink.start);
              const { href } = htmlLink;
              style = htmlLink.style;
              htmlLink = undefined;
              if (label !== href && label !== href.replace(/^mailto:/, "")) {
                append(" ("); append(href, "url"); append(")");
              }
            } else if (!tag[1]) {
              const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(token.raw);
              if (href) {
                htmlLink = { href: expandTabs(decodeEntities(href[1] ?? href[2])),
                  start: segments.reduce((sum, segment) => sum + segment.text.length, 0), style };
                style = { ...style, kind: "link" };
              }
            }
            break;
          }
          if (["b", "strong", "i", "em", "code", "s", "del"].includes(name)) {
            if (tag[1]) {
              const saved = htmlStack.at(-1);
              if (saved?.tag === name) { style = saved.style; htmlStack.pop(); }
            } else {
              htmlStack.push({ tag: name, style });
              style = { ...style };
              if (name === "b" || name === "strong") style.bold = true;
              else if (name === "i" || name === "em") style.italic = true;
              else if (name === "code") style.kind = "code";
              else style.strike = true;
            }
          } else if (name === "img") append(htmlLineToText(token.raw));
          break;
        }
        case "escape": append(value.text); break;
        default: {
          if (value.tokens) { walk(value.tokens, style); break; }
          const text = expandTabs(decodeEntities(value.text ?? value.raw));
          if (style.kind !== "text") { append(text); break; }
          FILE_REFERENCE.lastIndex = 0;
          let position = 0;
          for (const match of text.matchAll(FILE_REFERENCE)) {
            const at = match.index;
            if (at > 0 && !/[\s("'[]/.test(text[at - 1])) continue;
            append(text.slice(position, at)); append(match[0], "file");
            position = at + match[0].length;
          }
          append(text.slice(position));
        }
      }
    }
  };
  walk(typeof source === "string" ? Lexer.lexInline(source, lexerOptions) : source, { kind: "text" });
  return segments;
}

export function inlinePlainText(text: string | readonly Token[]): string {
  return parseInlineSegments(text).map((segment) => segment.text).join("");
}
