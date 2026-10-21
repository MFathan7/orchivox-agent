import { eastAsianWidth } from "get-east-asian-width";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ASCII_PRINTABLE = /^[\u0020-\u007e]*$/;
const WIDTH_CACHE_LIMIT = 4096;
const widthCache = new Map<string, number>();
const EMOJI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2190, 0x21ff],
  [0x2300, 0x23ff],
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
  [0x1f000, 0x1faff],
];

/** Control characters are removed from rendered text and occupy no column. */
export function isControlCodePoint(code: number): boolean {
  return code === 0 || code < 0x20 || (code >= 0x7f && code < 0xa0);
}

/** Marks, joiners and selectors that never advance the cursor on their own. */
function isZeroWidthCodePoint(code: number): boolean {
  return (
    isControlCodePoint(code) ||
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0xfeff
  );
}

function isEmojiCodePoint(code: number): boolean {
  return EMOJI_RANGES.some(([start, end]) => code >= start && code <= end);
}

/**
 * Width of one grapheme cluster, matching what a terminal paints:
 * zero for marks, joiners and selectors, and a single glyph cell for clusters
 * such as emoji ZWJ sequences, flags and keycaps.
 */
function graphemeWidth(cluster: string): number {
  let visible = 0;
  let base = 0;
  let emoji = false;
  let forcedPresentation = false;
  for (const char of cluster) {
    const code = char.codePointAt(0) ?? 0;
    // VS16 and the keycap combiner force the emoji presentation of the base.
    if (code === 0xfe0f || code === 0x20e3) forcedPresentation = true;
    if (isZeroWidthCodePoint(code)) continue;
    visible += 1;
    if (base === 0) base = code;
    if (isEmojiCodePoint(code)) emoji = true;
  }
  if (visible === 0) return 0;
  if (forcedPresentation) return 2;
  if (visible > 1) {
    return emoji ? 2 : eastAsianWidth(base, { ambiguousAsWide: false });
  }
  return eastAsianWidth(base, { ambiguousAsWide: false });
}

/** Iterates the grapheme clusters of a string, the unit a terminal draws as one glyph. */
export function graphemeClusters(text: string): string[] {
  const clusters: string[] = [];
  for (const { segment } of graphemeSegmenter.segment(text)) clusters.push(segment);
  return clusters;
}

export function charDisplayWidth(char: string): number {
  return graphemeWidth(char);
}

/** Terminal column width of a string, measured per grapheme cluster. */
export function displayWidth(text: string): number {
  if (text.length === 0) return 0;
  if (ASCII_PRINTABLE.test(text)) return text.length;
  const cached = widthCache.get(text);
  if (cached !== undefined) return cached;
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) width += graphemeWidth(segment);
  if (widthCache.size >= WIDTH_CACHE_LIMIT) widthCache.clear();
  widthCache.set(text, width);
  return width;
}

const DEFAULT_TAB_SIZE = 4;

function expandTabsInLine(line: string, tabSize: number): string {
  let column = 0;
  let output = "";
  for (const { segment } of graphemeSegmenter.segment(line)) {
    if (segment === "\t") {
      const spaces = tabSize - (column % tabSize);
      output += " ".repeat(spaces);
      column += spaces;
      continue;
    }
    let cleaned = "";
    for (const char of segment) {
      if (isControlCodePoint(char.codePointAt(0) ?? 0)) continue;
      cleaned += char;
    }
    if (cleaned.length === 0) continue;
    output += cleaned;
    column += graphemeWidth(cleaned);
  }
  return output;
}

/** Expands tabs and removes terminal control characters without touching newlines. */
export function expandTabs(text: string, tabSize = DEFAULT_TAB_SIZE): string {
  return text
    .split("\n")
    .map((line) => expandTabsInLine(line, Math.max(1, tabSize)))
    .join("\n");
}

/**
 * Longest prefix of `text` that fits in `width` columns without splitting a
 * grapheme cluster. Returns the kept text and its display width.
 */
export function truncateToWidth(text: string, width: number): { text: string; width: number } {
  const max = Math.max(0, width);
  if (max === 0) return { text: "", width: 0 };
  const total = displayWidth(text);
  if (total <= max) return { text, width: total };
  let output = "";
  let used = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = graphemeWidth(segment);
    if (used + segmentWidth > max) break;
    output += segment;
    used += segmentWidth;
  }
  return { text: output, width: used };
}

/** Truncates plain text to a display width using a short ellipsis. */
export function fitDisplayText(text: string, width: number, ellipsis = "..."): string {
  const plain = expandTabs(text);
  const max = Math.max(1, width);
  if (displayWidth(plain) <= max) return plain;
  const ellipsisWidth = displayWidth(ellipsis);
  if (max <= ellipsisWidth) return truncateToWidth(plain, max).text;
  return `${truncateToWidth(plain, max - ellipsisWidth).text}${ellipsis}`;
}

/** Hard-wraps a line at a display width without collapsing whitespace. */
export function wrapPreservingWhitespace(line: string, width: number): string[] {
  const max = Math.max(1, width);
  const expanded = expandTabs(line);
  if (expanded.length === 0) return [""];
  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const { segment } of graphemeSegmenter.segment(expanded)) {
    const segmentWidth = graphemeWidth(segment);
    if (current.length > 0 && currentWidth + segmentWidth > max) {
      rows.push(current);
      current = "";
      currentWidth = 0;
    }
    current += segment;
    currentWidth += segmentWidth;
  }
  rows.push(current);
  return rows;
}

/**
 * Wraps plain text to a display width, preserving explicit newlines and
 * hard-breaking words that are wider than the line.
 */
export function wrapText(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const lines: string[] = [];

  for (const paragraph of expandTabs(text).split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let line = "";
    for (const word of words) {
      const candidate = line.length > 0 ? `${line} ${word}` : word;
      if (displayWidth(candidate) <= max) {
        line = candidate;
        continue;
      }

      if (line.length > 0) {
        lines.push(line);
        line = "";
      }

      if (displayWidth(word) <= max) {
        line = word;
        continue;
      }

      let chunk = "";
      let chunkWidth = 0;
      for (const { segment } of graphemeSegmenter.segment(word)) {
        const segmentWidth = graphemeWidth(segment);
        if (chunkWidth + segmentWidth > max) {
          if (chunk.length > 0) lines.push(chunk);
          chunk = segment;
          chunkWidth = segmentWidth;
        } else {
          chunk += segment;
          chunkWidth += segmentWidth;
        }
      }
      line = chunk;
    }

    lines.push(line);
  }

  return lines.length > 0 ? lines : [""];
}
