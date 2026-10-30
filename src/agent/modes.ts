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
  /** Nudge once when files changed but nothing verified them. */
  verifyEdits: boolean;
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
    prompt: [
      "You are in PLAN mode, acting as the lead architect.",
      "Your job is the plan, not the implementation.",
      "Inspect the workspace with read, search, and read-only shell commands before you commit to a plan.",
      "Discuss the plan directly in the conversation: what changes, why, which files, in what order, the risks, and how it will be verified.",
      "Do not create or update plan files unless the user explicitly asks you to.",
      "When the user asks to save a plan, write only a PLAN*.md file in the active project directory with write_plan. Do not modify any other file.",
      "For large exploration, spawn one or two read-only explore workers and ask for findings instead of raw file dumps.",
      "Never modify other files, and never paste a full script, patch, or complete implementation.",
      "You remain in plan mode until the user switches modes. If the user asks you to implement, tell them they need to switch to build mode. Do not implement it yourself.",
      "Never call the question tool to ask whether to switch to build mode or whether to execute the plan.",
      "When the plan is ready, end with plain text telling the user to press Tab or run /build to start implementation, or /ultrawork for autonomous execution.",
      "Use the question tool only when an architectural requirement or technical specification is genuinely unclear before planning. Do not end a plan with a menu of options.",
      "Reply in the user's language and keep the plan short enough to act on.",
    ],
    compactPrompt: "You are in plan mode: discuss the plan in chat and keep project files read-only. Write a PLAN*.md file only when the user explicitly asks.",
    finalReminder:
      "Current mode: PLAN. Inspect and discuss the plan in chat. Do not create a plan file unless the user asks; then use write_plan for a PLAN*.md file in the active project directory. Do not edit other files or implement. Do not call the question tool to switch modes. When the plan is ready, tell the user in plain text to press Tab or run /build to implement, or /ultrawork for autonomous work.",
    toolPolicy: "read-only",
    fullAccess: false,
    enforceTodos: false,
    verifyEdits: false,
    nudges: 0,
    advisor: false,
    subagents: true,
  },
  build: {
    label: "BUILD",
    hint: "implement and verify",
    prompt: [
      "You are in BUILD mode.",
      "Implement the request now. Do not reply with a plan instead of doing the work.",
      "If an active skill tells you to ask the user a question before working, call the question tool first. That instruction wins over the default to implement immediately.",
      "If the user references a plan file, read it once and follow it. Do not look for plan files the user did not mention.",
      "A plan file is not implementation. When the user asks to implement a plan, change the code files it describes with the edit tools, then verify. Do not claim completion when no files changed.",
      "Write the implementation order with todo_write, then start editing. Do not run another discovery pass first.",
      "Work one todo item per step: mark it in progress, make the smallest complete change, verify it, then mark it complete. Do not plan the whole implementation in one reasoning pass.",
      "For codebase or web exploration that is not already in the plan, use read-only subagents with spawn_subagents so the main context stays small.",
      "Implement the requested change completely, then prove it works.",
      "Read a file before editing it and keep the diff focused on the request.",
      "Before you claim success, run diagnostics_check and the tests that cover the change, and report what you ran.",
      "Stop when the request is done and verified. Do not keep working on unrelated improvements.",
    ],
    compactPrompt: "You are in build mode: implement the request, work one todo item per step, verify, then stop.",
    finalReminder:
      "Current mode: BUILD. Implement the request with tools, one todo item per step. Verify, then report what changed.",
    toolPolicy: "build",
    fullAccess: true,
    enforceTodos: false,
    verifyEdits: true,
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
    verifyEdits: true,
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
