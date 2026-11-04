import type { PromptPart } from "./types";

// Tool guidance uses Orchivox tool names. The edit line describes hashline
// anchors because hash_edit is anchor based, not oldString based.
const SHELL_GUIDANCE = [
  "- Prefer dedicated tools over shell commands; fall back to the shell tool when a tool cannot do what you need.",
  "- Do not assume bash; use the shell syntax reported in Environment.",
  '- Do not chain shell commands with separators like `echo "====";` or `printf \'---\'`; the output becomes noisy in a way that makes the user\'s side of the conversation worse.',
];

const WRITE_GUIDANCE = [
  "- Use the create_file tool to create files or completely replace their content. Prefer using the hash_edit tool for targeted changes.",
];

const EDIT_GUIDANCE = [
  "- Use the hash_edit tool for targeted line-range changes. Read the file first and use the line:hash anchors from the read result.",
];

const REPLACE_GUIDANCE = [
  "- Use the replace_text tool for a focused exact-text edit when it is available. oldString must match once unless replaceAll is true.",
];

const CODE_MODE_GUIDANCE = [
  "- Use the execute tool to batch independent reads or searches in one script and return only the relevant result. It runs with the same permissions as the agent.",
];

export function toolGuidanceText(toolNames?: string[]): string {
  const active = toolNames ? new Set(toolNames) : undefined;
  const lines: string[] = [];
  if (!active || active.has("shell") || active.has("bash") || active.has("bg_start")) {
    lines.push(...SHELL_GUIDANCE);
  }
  if (!active || active.has("create_file")) lines.push(...WRITE_GUIDANCE);
  if (!active || active.has("hash_edit")) lines.push(...EDIT_GUIDANCE);
  if (!active || active.has("replace_text")) lines.push(...REPLACE_GUIDANCE);
  if (!active || active.has("execute")) lines.push(...CODE_MODE_GUIDANCE);
  return lines.join("\n");
}

export function toolGuidancePart(toolNames?: string[]): PromptPart {
  return {
    kind: "tools",
    key: "tool-guidance",
    text: toolGuidanceText(toolNames),
    stable: true,
  };
}

export function compactToolGuidanceText(toolNames?: string[]): string {
  return toolGuidanceText(toolNames);
}
