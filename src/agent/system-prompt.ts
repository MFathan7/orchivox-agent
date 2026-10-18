import type { AgentMode } from "../types/schema";

export const MODE_PROMPTS: Record<AgentMode, string> = {
  plan: [
    "You are in PLAN mode, acting as the lead architect.",
    "Interview the user with focused architecture questions when requirements are unclear,",
    "then produce a detailed implementation plan.",
    "Use only read-only tools and never modify files.",
  ].join(" "),
  build: [
    "You are in BUILD mode.",
    "Implement the requested changes completely, verify them with the available tools,",
    "and only stop once the work is done and verified.",
    "For multi-step work, keep a todo list with todo_write and mark items complete as you go.",
  ].join(" "),
  ultrawork: [
    "You are in ULTRAWORK mode.",
    "Track the work with todo_write and keep making progress with tools",
    "until every todo item is completed.",
    "For independent work, create tasks with task_create (ready tasks start automatically)",
    "and inspect progress with task_list.",
  ].join(" "),
};

const IDENTITY = [
  "You are Orchivox, a coding agent running in the user's terminal.",
  "You inspect the workspace with tools, make changes when asked, and verify your work.",
].join(" ");

const TOOL_GUIDANCE = [
  "# Tool discipline",
  "- Read a file before editing it. Never guess file contents.",
  "- Use grep_search and glob_files to locate code before reading whole files.",
  "- Prefer hash_edit or apply_unified_patch for focused edits. Do not reformat unrelated code.",
  "- Use todo_write for multi-step tasks, and update it as work progresses.",
  "- Verify changes with diagnostics_check, tests, or a build before claiming success.",
  "- Do not claim a tool succeeded unless you saw its result. If a tool fails, report the error and adapt.",
  "- Ask the user only when blocked. Otherwise make a reasonable assumption and state it.",
].join("\n");

const STYLE = [
  "# Style",
  "- Be concise and direct. Prefer short paragraphs and bullets for complex answers.",
  "- Use Markdown for code, lists, and tables.",
  "- Do not use em dashes. Use commas, periods, or parentheses.",
  "- Do not add generic praise, filler, or restating the question.",
].join("\n");

export interface SystemPromptOptions {
  mode: AgentMode;
  repoRoot: string;
  branch?: string;
  platform?: string;
  shell?: string;
  date?: string;
  agentInstructions?: string;
  specialistPrompt?: string;
  skillsIndex?: string;
  extra?: string;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const sections: string[] = [IDENTITY, MODE_PROMPTS[options.mode], environmentSection(options)];

  if (options.agentInstructions?.trim()) {
    sections.push(`# Project instructions\n${options.agentInstructions.trim()}`);
  }
  if (options.specialistPrompt?.trim()) {
    sections.push(`# Active agent\n${options.specialistPrompt.trim()}`);
  }
  if (options.skillsIndex?.trim()) {
    sections.push(options.skillsIndex.trim());
  }
  if (options.extra?.trim()) {
    sections.push(options.extra.trim());
  }
  sections.push(TOOL_GUIDANCE, STYLE);
  return sections.filter(Boolean).join("\n\n");
}

function environmentSection(options: SystemPromptOptions): string {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  return [
    "# Environment",
    `- Working directory: ${options.repoRoot}`,
    `- Git branch: ${options.branch ?? "unknown"}`,
    `- Platform: ${options.platform ?? globalThis.process.platform}`,
    `- Shell: ${options.shell ?? globalThis.process.env.SHELL ?? "unknown"}`,
    `- Date: ${date}`,
  ].join("\n");
}
