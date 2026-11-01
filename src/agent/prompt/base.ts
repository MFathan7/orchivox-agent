import type { AgentMode } from "../../types/schema";
import { modeContract } from "../modes";
import type { PromptPart, SystemPromptOptions } from "./types";

export const MODE_PROMPTS: Record<AgentMode, string> = {
  plan: modeContract("plan").prompt.join(" "),
  build: modeContract("build").prompt.join(" "),
  ultrawork: modeContract("ultrawork").prompt.join(" "),
};

export const TASK_REMINDERS = {
  study: "Current task: study the project and report what exists. Do not write code or a patch.",
  review: "Current task: answer the question about the existing code. Do not rewrite files unless asked.",
} as const;

export const TASK_PROMPTS = {
  study: [
    "You are in PROJECT STUDY mode.",
    "Read the provided project evidence and write a report about what exists.",
    "Do not write, edit, or replace code. Do not continue a previous implementation.",
    "Do not output a patch, a file rewrite, or a plan to build something.",
    "Do not greet. Do not describe agent instructions, skills, tool policy, or internal gates.",
    "Answer only the user's request.",
  ].join(" "),
  review: [
    "You are answering a question about existing code.",
    "Use the provided evidence and report findings, behavior, and risks.",
    "Do not rewrite the file unless the user explicitly asks for a fix.",
    "Answer the question directly.",
  ].join(" "),
} as const;

export function specialistPart(options: SystemPromptOptions): PromptPart | undefined {
  if (!options.specialistPrompt?.trim()) return undefined;
  return {
    kind: "agent",
    key: "specialist",
    text: `# Active agent\n${options.specialistPrompt.trim()}`,
    stable: false,
  };
}

export function modeAdditionPart(options: SystemPromptOptions): PromptPart | undefined {
  const text = options.task ? TASK_PROMPTS[options.task] : MODE_PROMPTS[options.mode];
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return {
    kind: "agent",
    key: options.task ? `task-${options.task}` : `mode-${options.mode}`,
    text: trimmed,
    stable: true,
  };
}

export function closingReminder(options: Pick<SystemPromptOptions, "task">): string {
  return options.task ? TASK_REMINDERS[options.task] : "";
}

export function closingPart(options: SystemPromptOptions): PromptPart | undefined {
  const text = closingReminder(options);
  if (!text) return undefined;
  return {
    kind: "closing",
    key: "closing",
    text,
    stable: true,
  };
}
