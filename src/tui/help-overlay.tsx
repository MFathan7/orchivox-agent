import React from "react";
import { Box, Text, useInput } from "ink";

import { getTheme, type Theme } from "./theme";

export interface HelpRow {
  keys: string;
  description: string;
}

export interface HelpSection {
  title: string;
  rows: HelpRow[];
  note?: string;
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    title: "Commands",
    rows: [
      { keys: "/help", description: "Open this panel" },
      { keys: "/models", description: "Inspect roles and connect providers" },
      { keys: "/palette", description: "Search actions and settings" },
      { keys: "/mode <name>", description: "Switch plan, build, or ultrawork" },
      { keys: "/theme <name>", description: "Switch the color preset" },
      { keys: "/reasoning <level>", description: "Set thinking effort" },
      { keys: "/sessions", description: "Browse and search sessions" },
      { keys: "/new", description: "Start a fresh session" },
      { keys: "/fork", description: "Branch the active session" },
      { keys: "/timeline", description: "Inspect snapshot history" },
      { keys: "/hub", description: "Inspect subagent workers" },
      { keys: "/tasks", description: "Open the multi-agent task board" },
      { keys: "/skills", description: "Inspect installed skills" },
      { keys: "/undo, /redo", description: "Step through snapshots" },
      { keys: "/commit", description: "Split changes into atomic commits" },
      { keys: "/compact", description: "Compact the context window" },
      { keys: "/stats", description: "Show session and workspace stats" },
      { keys: "/plugins", description: "List active plugins" },
      { keys: "/collab", description: "Start a live sharing relay" },
      { keys: "/clear", description: "Clear the transcript" },
      { keys: "/exit", description: "Close Orchivox" },
    ],
  },
  {
    title: "Editing",
    rows: [
      { keys: "Enter", description: "Send the prompt" },
      { keys: "Shift+Enter", description: "Insert a newline" },
      { keys: "Ctrl+Left/Right", description: "Move by word" },
      { keys: "Ctrl+Backspace", description: "Delete the previous word" },
      { keys: "Ctrl+Delete", description: "Delete the next word" },
      { keys: "Ctrl+A / Ctrl+E", description: "Jump to line start or end" },
      { keys: "Ctrl+U / Ctrl+K", description: "Delete to start or end of line" },
      { keys: "Ctrl+Z / Ctrl+Shift+Z", description: "Undo or redo an edit" },
      { keys: "Up / Down", description: "Browse command history, or move lines in a multiline draft" },
      { keys: "Alt+Up / Alt+Down", description: "Scroll the transcript" },
      { keys: "$name", description: "Mention an installed skill" },
    ],
  },
  {
    title: "Panels",
    rows: [
      { keys: "Tab", description: "Cycle the agent mode" },
      { keys: "Ctrl+P", description: "Open the command palette" },
      { keys: "Ctrl+G", description: "Open this help panel" },
      { keys: "Ctrl+S", description: "Open the session manager" },
      { keys: "Alt+A", description: "Open the subagent hub" },
      { keys: "Hub keys", description: "Tab switch · d dispatch · m merge · x cancel · s steer · k kill" },
      { keys: "Ctrl+B", description: "Toggle the sidebar" },
      { keys: "Ctrl+O", description: "Collapse or expand activity and thinking" },
      { keys: "Click Activity", description: "Expand or collapse a tool activity group" },
      { keys: "Mouse wheel", description: "Scroll the transcript" },
      { keys: "PageUp / PageDown", description: "Scroll the transcript by a page" },
      { keys: "End", description: "Jump to the bottom of the transcript" },
      { keys: "Esc", description: "Close a panel" },
      { keys: "Esc ×2", description: "Stop the current turn" },
    ],
  },
  {
    title: "Custom commands",
    rows: [
      { keys: "/review", description: "Review changes with the Oracle agent" },
      { keys: "/fix-tests", description: "Run tests and fix failures" },
      { keys: "/refactor", description: "Refactor a file in structured steps" },
      { keys: "/init-rules", description: "Create rule definitions" },
    ],
    note: "Defined in .agent/commands/*.md. Type / to list every available command.",
  },
];

export interface HelpOverlayProps {
  theme?: Theme;
  width?: number;
  height?: number;
  onClose: () => void;
}

type HelpLine =
  | { kind: "section"; text: string }
  | { kind: "row"; keys: string; description: string }
  | { kind: "note"; text: string }
  | { kind: "blank" };

export function buildHelpLines(): HelpLine[] {
  const keyWidth = HELP_SECTIONS.reduce(
    (widest, section) => Math.max(widest, ...section.rows.map((row) => row.keys.length)),
    0,
  );
  const lines: HelpLine[] = [];
  for (const section of HELP_SECTIONS) {
    if (lines.length > 0) lines.push({ kind: "blank" });
    lines.push({ kind: "section", text: section.title });
    for (const row of section.rows) {
      lines.push({ kind: "row", keys: row.keys.padEnd(keyWidth, " "), description: row.description });
    }
    if (section.note) lines.push({ kind: "note", text: section.note });
  }
  return lines;
}

export function HelpOverlay({
  theme = getTheme("tokyonight"),
  width = 80,
  height = 24,
  onClose,
}: HelpOverlayProps): React.ReactElement {
  const lines = React.useMemo(() => buildHelpLines(), []);
  const visibleCount = Math.max(6, height - 4);
  const [offset, setOffset] = React.useState(0);
  const maxOffset = Math.max(0, lines.length - visibleCount);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setOffset((value) => Math.max(0, value - 1));
      return;
    }
    if (key.downArrow) {
      setOffset((value) => Math.min(maxOffset, value + 1));
      return;
    }
    if (key.pageUp) {
      setOffset((value) => Math.max(0, value - visibleCount));
      return;
    }
    if (key.pageDown) {
      setOffset((value) => Math.min(maxOffset, value + visibleCount));
    }
  });

  const clamped = Math.min(offset, maxOffset);
  const visible = lines.slice(clamped, clamped + visibleCount);

  return (
    <Box flexDirection="column" width={Math.max(20, width - 2)} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={theme.accent}>Help</Text>
        <Text color={theme.muted}>{clamped + 1}-{Math.min(clamped + visibleCount, lines.length)} of {lines.length}</Text>
      </Box>
      <Text color={theme.border.passive}>{"─".repeat(Math.max(20, width - 4))}</Text>
      <Box flexDirection="column">
        {visible.map((line, index) => {
          if (line.kind === "blank") return <Text key={index}> </Text>;
          if (line.kind === "section") {
            return (
              <Text key={index} bold color={theme.modes.plan.primary}>
                {line.text}
              </Text>
            );
          }
          if (line.kind === "note") {
            return (
              <Text key={index} color={theme.muted}>
                {line.text}
              </Text>
            );
          }
          return (
            <Text key={index}>
              <Text color={theme.accent}>{line.keys}</Text>
              <Text>{"  "}</Text>
              <Text color={theme.text}>{line.description}</Text>
            </Text>
          );
        })}
      </Box>
      <Text color={theme.border.passive}>{"─".repeat(Math.max(20, width - 4))}</Text>
      <Text color={theme.muted}>Up/Down scroll · PageUp/PageDown jump · Esc close</Text>
    </Box>
  );
}
