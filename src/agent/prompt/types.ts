import type { AgentMode } from "../../types/schema";

export type PromptPartKind = "agent" | "tools" | "instructions" | "extra" | "closing";

export interface PromptPart {
  kind: PromptPartKind;
  key: string;
  text: string;
  /** Stable parts are candidates for prompt caching. Volatile parts are not. */
  stable: boolean;
}

export interface SystemPromptOptions {
  mode: AgentMode;
  task?: "study" | "review";
  /** Provider kind used to select a prompt profile. */
  providerKind?: string;
  /** Model id used to select a prompt profile. */
  model?: string;
  /** Human-readable model name used by profile text placeholders. */
  modelName?: string;
  repoRoot: string;
  branch?: string;
  platform?: string;
  shell?: string;
  date?: string;
  time?: string;
  timezone?: string;
  now?: Date;
  agentInstructions?: string;
  specialistPrompt?: string;
  projectSummary?: string;
  skillsIndex?: string;
  extra?: string;
  compact?: boolean;
  /** Include environment, project, rules, and skills in the system prompt. Defaults to true. */
  includeInstructions?: boolean;
  /** Include the final mode or task reminder. Defaults to true. */
  includeClosing?: boolean;
  /** Active tool names. When omitted, all guidance is rendered for compatibility. */
  tools?: string[];
}
