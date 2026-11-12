import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "./spinner";
import { displayWidth } from "./text-wrap";

/** One terminal row. The node must render exactly one line. */
export interface RenderRow {
  key: string;
  node: React.ReactNode;
}

export interface RowContent {
  node: React.ReactNode;
  text: string;
}

const contentCache = new WeakMap<object, RowContent>();

/** Flatten a single-row layout so text and its gutter share one terminal write. */
export function rowContent(node: React.ReactNode): RowContent {
  if (typeof node === "string" || typeof node === "number") return { node, text: String(node) };
  if (!node || typeof node === "boolean") return { node, text: "" };
  if (Array.isArray(node)) {
    const children = node.map(rowContent);
    return { node: React.createElement(React.Fragment, null, ...children.map((child) => child.node)), text: children.map((child) => child.text).join("") };
  }
  if (!React.isValidElement(node)) return { node, text: "" };
  const cached = contentCache.get(node);
  if (cached) return cached;
  const props = node.props as { children?: React.ReactNode; text?: string; width?: number };
  const children = rowContent(props.children);
  let result: RowContent;
  if (node.type === Box) {
    const padding = typeof props.width === "number" ? " ".repeat(Math.max(0, props.width - displayWidth(children.text))) : "";
    result = { node: React.createElement(Text, null, children.node, padding), text: children.text + padding };
  } else if (node.type === Text || node.type === React.Fragment) {
    result = { node: React.cloneElement(node, undefined, children.node), text: children.text };
  } else {
    result = { node, text: typeof props.text === "string" ? props.text : node.type === Spinner ? "● " : children.text };
  }
  contentCache.set(node, result);
  return result;
}
