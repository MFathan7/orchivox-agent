import React from "react";
import { Text } from "ink";
import { rowContent } from "./rows";
import { displayWidth, graphemeClusters } from "./text-wrap";
import type { Theme } from "./theme";

export interface SelectionPoint { row: number; column: number }
export interface TextSelection { anchor: SelectionPoint; focus: SelectionPoint }

export function selectionRange(selection: TextSelection, row: number, width: number): { from: number; to: number } | undefined {
  const { anchor, focus } = selection;
  const forward = anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column);
  const first = forward ? anchor : focus;
  const last = forward ? focus : anchor;
  if (row < first.row || row > last.row) return undefined;
  return { from: row === first.row ? first.column : 0, to: row === last.row ? last.column + 1 : width };
}

export function selectedText(lines: readonly string[], selection: TextSelection, width: number): string {
  const result: string[] = [];
  lines.forEach((line, row) => {
    const range = selectionRange(selection, row, width);
    if (!range) return;
    let column = 0;
    let text = "";
    for (const cluster of graphemeClusters(line)) {
      const end = column + displayWidth(cluster);
      if (end > range.from && column < range.to) text += cluster;
      column = end;
    }
    result.push(text.replace(/\u200b/g, "").trimEnd());
  });
  return result.join("\n");
}

export function highlightSelection(node: React.ReactNode, from: number, to: number, theme: Theme): React.ReactNode {
  let column = 0;
  const visit = (child: React.ReactNode): React.ReactNode => {
    if (typeof child === "string" || typeof child === "number") {
      const runs: Array<{ text: string; selected: boolean }> = [];
      for (const cluster of graphemeClusters(String(child))) {
        const end = column + displayWidth(cluster);
        const selected = end > from && column < to;
        const last = runs.at(-1);
        if (last?.selected === selected) last.text += cluster;
        else runs.push({ text: cluster, selected });
        column = end;
      }
      return React.createElement(React.Fragment, null, ...runs.map((run, key) => run.selected
        ? React.createElement(Text, { key, color: theme.background, backgroundColor: theme.selection }, run.text)
        : run.text));
    }
    if (Array.isArray(child)) return child.map(visit);
    if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return child;
    if (child.type === Text || child.type === React.Fragment) return React.cloneElement(child, undefined, visit(child.props.children));
    column += displayWidth(rowContent(child).text);
    return child;
  };
  return visit(node);
}
