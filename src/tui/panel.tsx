import React from "react";
import { Text } from "ink";

import { displayWidth, truncateToWidth } from "./text-wrap";

export const PANEL_PAD = " ";

/**
 * Zero-width sentinel kept inside the painted span so Ink cannot trim the
 * trailing padding spaces off a row.
 */
export const PANEL_END = "\u200b";

export interface PanelPart {
  /** Plain text of the part, used for measuring and for truncation. */
  text: string;
  /** Styled rendering of the same text. Falls back to `text` when absent. */
  node?: React.ReactNode;
  /** Foreground kept when the part has to be shortened. */
  color?: string;
}

export interface PanelFit {
  parts: PanelPart[];
  width: number;
}

/**
 * Shortens parts to fit `width` columns, keeping styled runs intact until the
 * cut point and ending the row with a plain ellipsis.
 */
export function fitPanelParts(parts: PanelPart[], width: number): PanelFit {
  const total = parts.reduce((sum, part) => sum + displayWidth(part.text), 0);
  if (total <= width) return { parts, width: total };

  const ellipsis = "...";
  const limit = Math.max(0, width - displayWidth(ellipsis));
  const fitted: PanelPart[] = [];
  let used = 0;
  for (const part of parts) {
    if (used >= limit) break;
    const cut = truncateToWidth(part.text, limit - used);
    if (cut.text.length === 0) continue;
    fitted.push(
      cut.text === part.text
        ? part
        : { text: cut.text, node: <Text color={part.color}>{cut.text}</Text>, color: part.color },
    );
    used += cut.width;
  }
  fitted.push({ text: ellipsis });
  return { parts: fitted, width: used + displayWidth(ellipsis) };
}

export interface PanelRowOptions {
  /** Inner width of the panel, excluding margin. */
  width: number;
  background: string;
  /** Left margin in spaces, applied outside the painted span. */
  margin: number;
}

/** One painted panel row: margin, fitted content, full-width padding, sentinel. */
export function panelRowNode(parts: PanelPart[], options: PanelRowOptions): React.ReactElement {
  const fitted = fitPanelParts(parts, options.width);
  const padding = PANEL_PAD.repeat(Math.max(0, options.width - fitted.width));
  return (
    <Text wrap="truncate">
      {" ".repeat(Math.max(0, options.margin))}
      <Text backgroundColor={options.background}>
        {fitted.parts.map((part, index) =>
          part.node === undefined ? (
            part.text
          ) : (
            <React.Fragment key={index}>{part.node}</React.Fragment>
          ),
        )}
        {padding}
        {PANEL_END}
      </Text>
    </Text>
  );
}

/** Blank painted row used as the panel's top and bottom padding. */
export function panelPaddingRowNode(options: PanelRowOptions): React.ReactElement {
  return (
    <Text wrap="truncate">
      {" ".repeat(Math.max(0, options.margin))}
      <Text backgroundColor={options.background}>
        {PANEL_PAD.repeat(options.width)}
        {PANEL_END}
      </Text>
    </Text>
  );
}
