import type { PromptPart, SystemPromptOptions } from "./types";

function timeParts(options: SystemPromptOptions): {
  date: string;
  time: string;
  timezone: string;
} {
  const now = options.now ?? new Date();
  const date = options.date ?? now.toISOString().slice(0, 10);
  const time =
    options.time ??
    now.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    });
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { date, time, timezone: timezone || "unknown" };
}

export function environmentPart(options: SystemPromptOptions): PromptPart {
  const { date, time, timezone } = timeParts(options);
  return {
    kind: "instructions",
    key: "environment",
    text: [
      "# Environment",
      `- Working directory: ${options.repoRoot}`,
      `- Git branch: ${options.branch ?? "unknown"}`,
      `- Platform: ${options.platform ?? globalThis.process.platform}`,
      `- Shell: ${options.shell ?? globalThis.process.env.SHELL ?? "unknown"}`,
      `- Date: ${date}`,
      `- Local time: ${time}`,
      `- Timezone: ${timezone}`,
    ].join("\n"),
    stable: false,
  };
}

export function compactEnvironmentText(options: SystemPromptOptions): string {
  const { date, time, timezone } = timeParts(options);
  return `Environment: ${options.repoRoot} (branch ${options.branch ?? "unknown"}). Date: ${date}. Local time: ${time} (${timezone}).`;
}

export function projectPart(options: SystemPromptOptions): PromptPart | undefined {
  if (!options.projectSummary?.trim()) return undefined;
  return {
    kind: "instructions",
    key: "project-summary",
    text: options.projectSummary.trim(),
    stable: true,
  };
}

export function rulesPart(options: SystemPromptOptions): PromptPart | undefined {
  if (!options.agentInstructions?.trim()) return undefined;
  return {
    kind: "instructions",
    key: "project-rules",
    text: `# Project instructions\n${options.agentInstructions.trim()}`,
    stable: true,
  };
}

export function skillsPart(options: SystemPromptOptions): PromptPart | undefined {
  if (!options.skillsIndex?.trim()) return undefined;
  return {
    kind: "instructions",
    key: "skills-index",
    text: options.skillsIndex.trim(),
    stable: true,
  };
}

export interface InstructionBlock {
  key: string;
  text: string;
}

export function instructionBlocks(options: SystemPromptOptions): InstructionBlock[] {
  return [environmentPart(options), projectPart(options), rulesPart(options), skillsPart(options)]
    .filter((part): part is PromptPart => Boolean(part && part.text.trim().length > 0))
    .map((part) => ({ key: part.key, text: part.text.trim() }));
}

export function extraPart(options: SystemPromptOptions): PromptPart | undefined {
  if (!options.extra?.trim()) return undefined;
  return {
    kind: "extra",
    key: "extra",
    text: options.extra.trim(),
    stable: false,
  };
}
