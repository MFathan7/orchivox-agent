export function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code === 0x200d) return 0;
  if (code >= 0x0300 && code <= 0x036f) return 0;

  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd);

  return wide ? 2 : 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charDisplayWidth(char);
  return width;
}

/** Hard-wraps a line at a display width without collapsing whitespace. */
export function wrapPreservingWhitespace(line: string, width: number): string[] {
  const max = Math.max(1, width);
  if (line.length === 0) return [""];
  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const char of line) {
    const charWidth = charDisplayWidth(char);
    if (current.length > 0 && currentWidth + charWidth > max) {
      rows.push(current);
      current = "";
      currentWidth = 0;
    }
    current += char;
    currentWidth += charWidth;
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

  for (const paragraph of text.split("\n")) {
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
      for (const char of word) {
        if (displayWidth(chunk) + charDisplayWidth(char) > max) {
          if (chunk.length > 0) lines.push(chunk);
          chunk = char;
        } else {
          chunk += char;
        }
      }
      line = chunk;
    }

    lines.push(line);
  }

  return lines.length > 0 ? lines : [""];
}
