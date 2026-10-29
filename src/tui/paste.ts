export interface PastedEntry {
  label: string;
  text: string;
}

export function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Collapses multi-line or long pasted text into a placeholder, mirroring
 * A paste: 3 or more lines, or more than 150 characters.
 */
export function collapsePastedText(text: string): PastedEntry | null {
  const normalized = normalizePastedText(text);
  const lineCount = normalized.split("\n").length;
  if (lineCount < 3 && normalized.length <= 150) return null;
  const label = `[Pasted ${lineCount} ${lineCount === 1 ? "line" : "lines"}]`;
  return { label, text: normalized };
}

export function expandPastedText(text: string, entries: ReadonlyArray<PastedEntry>): string {
  let result = text;
  for (const entry of entries) {
    const index = result.indexOf(entry.label);
    if (index === -1) continue;
    result = `${result.slice(0, index)}${entry.text}${result.slice(index + entry.label.length)}`;
  }
  return result;
}

export function pastedPlaceholderBefore(
  text: string,
  cursor: number,
): { start: number; end: number } | null {
  const match = /\[Pasted \d+ lines?\]$/.exec(text.slice(0, cursor));
  return match ? { start: cursor - match[0].length, end: cursor } : null;
}

export function pastedPlaceholderAfter(
  text: string,
  cursor: number,
): { start: number; end: number } | null {
  const match = /^\[Pasted \d+ lines?\]/.exec(text.slice(cursor));
  return match ? { start: cursor, end: cursor + match[0].length } : null;
}
