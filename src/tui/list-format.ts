export type ListKind = "bullet" | "ordered";

export interface ListMarker {
  indent: string;
  kind: ListKind;
  marker: string;
}

const BULLET_LINE = /^(\s*)([-*+])(\s+)(.*)$/;
const ORDERED_LINE = /^(\s*)(\d+)([.)])(\s+)(.*)$/;

export function parseListLine(line: string): ListMarker | null {
  const bullet = BULLET_LINE.exec(line);
  if (bullet) {
    return { indent: bullet[1], kind: "bullet", marker: bullet[2] };
  }

  const ordered = ORDERED_LINE.exec(line);
  if (ordered) {
    return { indent: ordered[1], kind: "ordered", marker: `${ordered[2]}${ordered[3]}` };
  }

  return null;
}

/**
 * Renders a markdown bullet marker as a middle dot. The marker is one column
 * wide in both forms, so the cursor column stays aligned with the source text.
 */
export function displayListLine(line: string): string {
  const parsed = parseListLine(line);
  if (!parsed || parsed.kind !== "bullet") return line;

  const markerIndex = parsed.indent.length;
  return `${line.slice(0, markerIndex)}·${line.slice(markerIndex + 1)}`;
}

export interface ListContinuation {
  text: string;
  cursor: number;
}

/**
 * Continues the list marker at the cursor when a newline is inserted.
 * Returns null when the line is not a list item, so the caller can insert a
 * plain newline. An empty item exits the list instead of adding a new marker.
 */
export function continueList(text: string, cursorPos: number): ListContinuation | null {
  const cursor = Math.max(0, Math.min(text.length, cursorPos));
  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  const nextBreak = text.indexOf("\n", cursor);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;
  const line = text.slice(lineStart, lineEnd);
  const parsed = parseListLine(line);
  if (!parsed) return null;

  const markerEnd = lineStart + parsed.indent.length + parsed.marker.length;
  const content = line.slice(parsed.indent.length + parsed.marker.length).trim();
  const emptyItem = content.length === 0 && cursor >= markerEnd && cursor === lineEnd;

  if (emptyItem) {
    return {
      text: `${text.slice(0, lineStart)}${text.slice(lineEnd)}`,
      cursor: lineStart,
    };
  }

  const nextMarker =
    parsed.kind === "ordered"
      ? `${Number.parseInt(parsed.marker, 10) + 1}${parsed.marker.endsWith(")") ? ")" : "."}`
      : parsed.marker;
  const insert = `\n${parsed.indent}${nextMarker} `;

  return {
    text: `${text.slice(0, cursor)}${insert}${text.slice(cursor)}`,
    cursor: cursor + insert.length,
  };
}
