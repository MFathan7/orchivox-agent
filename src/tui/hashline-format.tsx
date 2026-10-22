import React from "react";
import { Text } from "ink";

import type { PanelPart } from "./panel";
import type { Theme } from "./theme";
import { displayWidth, wrapPreservingWhitespace } from "./text-wrap";

/** One anchored line from a tool result. */
export interface HashlineLine {
  /** File prefix, present on search results. */
  path?: string;
  lineNumber: number;
  content: string;
}

export interface HashlineBlock {
  lines: HashlineLine[];
  /** Trailing budget notice that is not part of the file, such as a truncation warning. */
  notice?: string;
}

const READ_LINE = /^(\d+):[0-9a-f]{3}\| ?(.*)$/;
const GREP_LINE = /^(.+?):(\d+):[0-9a-f]{3}\| ?(.*)$/;

/**
 * Parses `line:hash| content` reads and `path:line:hash| content` search hits.
 * Returns undefined unless every content line carries an anchor, so mixed
 * output keeps the plain renderer. One trailing notice line is allowed.
 */
export function parseHashlineOutput(text: string): HashlineBlock | undefined {
  const raw = text.split("\n").filter((line) => line.length > 0);
  if (raw.length === 0) return undefined;
  const parsed: HashlineLine[] = [];
  let reads = 0;
  let searches = 0;
  let notice: string | undefined;
  for (const [index, line] of raw.entries()) {
    const read = READ_LINE.exec(line);
    if (read) {
      parsed.push({ lineNumber: Number(read[1]), content: read[2] ?? "" });
      reads += 1;
      continue;
    }
    const search = GREP_LINE.exec(line);
    if (search) {
      parsed.push({
        path: search[1],
        lineNumber: Number(search[2]),
        content: search[3] ?? "",
      });
      searches += 1;
      continue;
    }
    if (index === raw.length - 1 && line.startsWith("[")) {
      notice = line;
      continue;
    }
    return undefined;
  }
  if (reads > 0 && searches > 0) return undefined;
  if (parsed.length === 0) return undefined;
  return notice === undefined ? { lines: parsed } : { lines: parsed, notice };
}

export interface HashlineRenderOptions {
  /** Inner width of the panel, excluding margin. */
  panelWidth: number;
  /** Left indent inside the panel. */
  innerPad: number;
  theme: Theme;
}

function padToWidth(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
}

/**
 * Renders anchored lines as a gutter plus content, dropping the edit hash from
 * the screen. The hash stays in the tool result the model receives.
 */
export function hashlinePanelParts(
  lines: HashlineLine[],
  options: HashlineRenderOptions,
): PanelPart[][] {
  const { panelWidth, innerPad, theme } = options;
  const numberWidth = Math.max(1, ...lines.map((line) => String(line.lineNumber).length));
  const paths = lines.filter((line) => line.path !== undefined);
  const pathWidth =
    paths.length === 0
      ? 0
      : Math.max(...paths.map((line) => displayWidth(line.path ?? ""))) + 1;
  const gutterWidth = numberWidth + 3;
  const contentWidth = Math.max(8, panelWidth - innerPad - pathWidth - gutterWidth);
  const rows: PanelPart[][] = [];

  for (const line of lines) {
    const pathText = pathWidth > 0 ? `${padToWidth(line.path ?? "", pathWidth - 1)} ` : "";
    wrapPreservingWhitespace(line.content, contentWidth).forEach((chunk, index) => {
      const numberText =
        index === 0
          ? String(line.lineNumber).padStart(numberWidth, " ")
          : " ".repeat(numberWidth);
      const body = chunk || " ";
      const parts: PanelPart[] = [{ text: " ".repeat(innerPad) }];
      if (pathText.length > 0) {
        parts.push({
          text: pathText,
          node: <Text color={theme.muted}>{pathText}</Text>,
          color: theme.muted,
        });
      }
      parts.push({
        text: numberText,
        node: <Text color={theme.border.passive}>{numberText}</Text>,
        color: theme.border.passive,
      });
      parts.push({
        text: " │ ",
        node: <Text color={theme.border.passive}>{" │ "}</Text>,
        color: theme.border.passive,
      });
      parts.push({
        text: body,
        node: <Text color={theme.text}>{body}</Text>,
        color: theme.text,
      });
      rows.push(parts);
    });
  }

  return rows;
}
