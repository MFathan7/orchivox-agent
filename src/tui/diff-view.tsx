import { structuredPatch } from "diff";
import React from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";

import { computeLineHash } from "../tools/hashline-edit";

export interface DiffViewProps {
  oldText: string;
  newText: string;
  oldLabel?: string;
  newLabel?: string;
  unified?: boolean;
  context?: number;
}

export interface ToolCallBadgeProps {
  name: string;
  argumentsSummary: string;
  durationMs?: number;
  status?: "running" | "ok" | "error";
  lspStatus?: string;
}

export interface ThinkingBlockProps {
  text: string;
  defaultOpen?: boolean;
  focused?: boolean;
}

interface DisplayLine {
  kind: "add" | "remove" | "context";
  oldNumber?: number;
  newNumber?: number;
  text: string;
}

interface DisplayHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DisplayLine[];
}

export function collectDiffHunks(oldText: string, newText: string, context = 3): DisplayHunk[] {
  const patch = structuredPatch("old", "new", oldText, newText, undefined, undefined, { context });
  return patch.hunks.map((hunk) => {
    let oldNumber = hunk.oldStart;
    let newNumber = hunk.newStart;
    const lines: DisplayLine[] = hunk.lines.map((raw) => {
      const marker = raw.charAt(0);
      const text = raw.slice(1);
      if (marker === "+") {
        return { kind: "add" as const, newNumber: newNumber++, text };
      }
      if (marker === "-") {
        return { kind: "remove" as const, oldNumber: oldNumber++, text };
      }
      return { kind: "context" as const, oldNumber: oldNumber++, newNumber: newNumber++, text };
    });
    return {
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines,
    };
  });
}

export function pairDiffLines(lines: DisplayLine[]): Array<{ left?: DisplayLine; right?: DisplayLine }> {
  const pairs: Array<{ left?: DisplayLine; right?: DisplayLine }> = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === "context") {
      pairs.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const removals: DisplayLine[] = [];
    const additions: DisplayLine[] = [];
    while (index < lines.length && lines[index].kind === "remove") removals.push(lines[index++]);
    while (index < lines.length && lines[index].kind === "add") additions.push(lines[index++]);
    const width = Math.max(removals.length, additions.length);
    for (let slot = 0; slot < width; slot += 1) {
      pairs.push({ left: removals[slot], right: additions[slot] });
    }
  }
  return pairs;
}

function lineHash(line: DisplayLine): string {
  return computeLineHash(line.text);
}

function unifiedLine(line: DisplayLine): { marker: string; color: string; gutter: string } {
  const number = line.kind === "add" ? line.newNumber : line.oldNumber;
  const gutter = `${String(number ?? "").padStart(4)} ${lineHash(line)}`;
  if (line.kind === "add") return { marker: "+", color: "green", gutter };
  if (line.kind === "remove") return { marker: "-", color: "red", gutter };
  return { marker: " ", color: "gray", gutter };
}

export function DiffView({ oldText, newText, oldLabel = "old", newLabel = "new", unified = false, context = 3 }: DiffViewProps) {
  const hunks = React.useMemo(() => collectDiffHunks(oldText, newText, context), [oldText, newText, context]);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold>
        {oldLabel} -&gt; {newLabel} {unified ? "(unified)" : "(side by side)"}
      </Text>
      {hunks.map((hunk, hunkIndex) => (
        <Box key={hunkIndex} flexDirection="column">
          <Text dimColor>
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </Text>
          {unified
            ? hunk.lines.map((line, lineIndex) => {
                const view = unifiedLine(line);
                return (
                  <Text key={lineIndex} color={view.color}>
                    {view.gutter} {view.marker} {line.text}
                  </Text>
                );
              })
            : pairDiffLines(hunk.lines).map((pair, lineIndex) => (
                <Box key={lineIndex}>
                  <Box width="50%">
                    {pair.left ? (
                      <Text color={pair.left.kind === "remove" ? "red" : "gray"}>
                        {String(pair.left.kind === "add" ? "" : (pair.left.oldNumber ?? "")).padStart(4)} {lineHash(pair.left)}{" "}
                        {pair.left.kind === "remove" ? "-" : " "} {pair.left.text}
                      </Text>
                    ) : (
                      <Text color="gray">{"     (empty)"}</Text>
                    )}
                  </Box>
                  <Box width="50%">
                    {pair.right ? (
                      <Text color={pair.right.kind === "add" ? "green" : "gray"}>
                        {String(pair.right.kind === "remove" ? "" : (pair.right.newNumber ?? "")).padStart(4)} {lineHash(pair.right)}{" "}
                        {pair.right.kind === "add" ? "+" : " "} {pair.right.text}
                      </Text>
                    ) : (
                      <Text color="gray">{"     (empty)"}</Text>
                    )}
                  </Box>
                </Box>
              ))}
        </Box>
      ))}
    </Box>
  );
}

export function ToolCallBadge({ name, argumentsSummary, durationMs, status = "ok", lspStatus }: ToolCallBadgeProps) {
  const statusColor = status === "running" ? "yellow" : status === "error" ? "red" : "green";
  const statusIcon = status === "running" ? "~" : status === "error" ? "x" : "+";
  return (
    <Box>
      <Text color={statusColor} bold>
        {statusIcon} {name}
      </Text>
      <Text dimColor> {argumentsSummary.length > 60 ? `${argumentsSummary.slice(0, 57)}...` : argumentsSummary}</Text>
      {durationMs !== undefined ? <Text color="gray"> {durationMs}ms</Text> : null}
      {lspStatus ? <Text color="yellow"> lsp:{lspStatus}</Text> : null}
    </Box>
  );
}

export function ThinkingBlock({ text, defaultOpen = false, focused = false }: ThinkingBlockProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  useInput(
    (input, key) => {
      if (key.return || input === " ") setOpen((value) => !value);
    },
    { isActive: focused },
  );
  const lines = text.split("\n");
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        {open ? "[-]" : "[+]"} thinking ({lines.length} line(s)){focused ? " - Enter to toggle" : ""}
      </Text>
      {open
        ? lines.map((line, index) => (
            <Text key={index} dimColor>
              {line}
            </Text>
          ))
        : null}
    </Box>
  );
}
