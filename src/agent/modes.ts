import type { AgentMode } from "../types/schema";

/**
 * Per-mode contract. This is the single source of truth for what each mode is
 * for: the prompt, the tool surface, the permission default, and the loop
 * rules that decide when a turn may end.
 */
export interface ModeContract {
  /** Short label shown in the header. */
  label: string;
  /** One-line description of the mode, shown next to the label. */
  hint: string;
  /** Prompt section that tells the model what this mode is for. */
  prompt: readonly string[];
  /** Compact variant used when the provider only gets a small prompt. */
  compactPrompt: string;
  /**
   * Last line of the system prompt. Small models follow the end of the prompt
   * best, so the mode rule is repeated after the long sections like skills.
   */
  finalReminder: string;
  /** Tool surface: read-only, build (edits plus delegation), or everything. */
  toolPolicy: "read-only" | "build" | "all";
  /** Mutating tools run without an approval prompt. */
  fullAccess: boolean;
  /** The turn cannot end while a todo is pending. */
  enforceTodos: boolean;
  /** How many times the turn may be pushed to continue. */
  nudges: number;
  /** Background diff review runs after edits. */
  advisor: boolean;
  /** The mode may spawn subagents and drive the task board. */
  subagents: boolean;
}

export const MODE_CONTRACTS: Record<AgentMode, ModeContract> = {
  plan: {
    label: "PLAN",
    hint: "read-only architect",
    prompt: [],
    compactPrompt: "",
    finalReminder: "",
    toolPolicy: "read-only",
    fullAccess: false,
    enforceTodos: false,
    nudges: 0,
    advisor: false,
    subagents: true,
  },
  build: {
    label: "BUILD",
    hint: "implement and verify",
    prompt: [],
    compactPrompt: "",
    finalReminder: "",
    toolPolicy: "all",
    fullAccess: true,
    enforceTodos: false,
    nudges: 0,
    advisor: false,
    subagents: true,
  },
  ultrawork: {
    label: "ULTRAWORK",
    hint: "finish autonomously",
    prompt: [
      "You are in ULTRAWORK mode.",
      "Own the task until it is finished: plan it, implement it, verify it, and report the evidence.",
      "Track the work with todo_write and do not stop while a todo item is pending or in progress.",
      "Use spawn_subagents for independent work and the task board (task_create, task_list) to track dispatched work.",
      "Verify with tools before you claim success, and fix what the verification exposes.",
      "Reply with a short final summary that names the changes and the checks that passed.",
    ],
    compactPrompt: "You are in ultrawork mode: keep working and verifying until every todo item is complete.",
    finalReminder:
      "Current mode: ULTRAWORK. Keep working autonomously with tools until the task is complete and verified. Do not stop for a status update.",
    toolPolicy: "all",
    fullAccess: true,
    enforceTodos: true,
    nudges: 2,
    advisor: true,
    subagents: true,
  },
};

export function modeContract(mode: AgentMode): ModeContract {
  return MODE_CONTRACTS[mode] ?? MODE_CONTRACTS.build;
}

export function modeTransitionReminder(from: AgentMode, to: AgentMode): string {
  return [
    `The user switched this session from ${from.toUpperCase()} to ${to.toUpperCase()} mode.`,
    `The previous ${from.toUpperCase()} mode instructions no longer apply.`,
    `Continue in ${to.toUpperCase()} mode.`,
    "Do not tell the user to switch modes, press Tab, or run /build; the switch already happened.",
  ].join(" ");
}

/**
 * Resolves a mode handoff from a question answer. Only a question that talks
 * about modes can switch anything, so an unrelated question can never change
 * the session mode by accident.
 */
export function modeFromQuestionAnswer(
  question: string,
  answers: readonly string[],
  declaredModeOptions = false,
): AgentMode | undefined {
  const aboutModes = /\b(plan|build|ultrawork|mode|switch|change)\b/i.test(question);
  if (!declaredModeOptions && !aboutModes) return undefined;
  for (const answer of answers) {
    const match = answer.match(/\b(plan|build|ultrawork)\b/i);
    if (match) return match[1].toLowerCase() as AgentMode;
  }
  return undefined;
}
