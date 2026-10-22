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
      "Your job is a plan that someone else can execute, not the implementation.",
      "Inspect the repository with read, search, and read-only shell commands before you commit to a plan.",
      "Interview the user with focused questions when requirements, constraints, or trade-offs are unclear, using the question tool for multiple-choice decisions.",
      "Write the answer as a plan: what changes, why, which files, in what order, the risks, how it will be verified, and any open question that still blocks work.",
      "Never modify files in plan mode, and never paste a full script, patch, or file as the answer.",
      "If the user asks for code, a file, or an implementation, offer the handoff with the question tool, set mode_options to true, and use plan and build as the options; the answer switches the session mode.",
      "Never ask the user to write the code themselves. The plan is your job; writing the code is the next mode's job.",
      "Reply in the user's language and keep the plan short enough to act on.",
    ],
    compactPrompt: "You are in plan mode: read-only, do not modify files. Inspect and produce an actionable plan.",
    toolPolicy: "read-only",
    fullAccess: false,
    enforceTodos: false,
    verifyEdits: false,
    nudges: 0,
    advisor: false,
    subagents: false,
  },
  build: {
    label: "BUILD",
    hint: "implement and verify",
    prompt: [
      "You are in BUILD mode.",
      "Implement the requested change completely, then prove it works.",
      "Read a file before editing it and keep the diff focused on the request.",
      "For work with three or more steps, keep a todo list with todo_write and mark items complete as you go.",
      "Before you claim success, run diagnostics_check and the tests that cover the change, and report what you ran.",
      "Stop when the request is done and verified. Do not keep working on unrelated improvements.",
    ],
    compactPrompt: "You are in build mode: make the requested change, verify it, then stop.",
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
  if (!declaredModeOptions && !/\b(plan|build|ultrawork)\b/i.test(question)) return undefined;
  for (const answer of answers) {
    const word = answer.trim().toLowerCase().match(/^[a-z]+/)?.[0];
    if (word === "plan" || word === "build" || word === "ultrawork") return word;
  }
  return undefined;
}
