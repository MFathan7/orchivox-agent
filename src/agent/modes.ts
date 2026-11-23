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
  /** Completion review text for the mode's bounded reminders. */
  finalReminder: string;
  /** Workflow guidance delivered in synthetic mode reminders. */
  workflowGuidance?: readonly string[];
  /** Shell constraints included in the mode's synthetic reminder. */
  shellGuidance?: readonly string[];
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
  /** Default provider steps for one turn. 0 means unlimited. */
  defaultSteps: number;
}

export const MODE_CONTRACTS: Record<AgentMode, ModeContract> = {
  plan: {
    label: "PLAN",
    hint: "read-only architect",
    prompt: [],
    compactPrompt: "",
    finalReminder: "",
    workflowGuidance: [
      "Scale planning to the request: a focused fix may need only a few concrete steps. Investigate code facts with inspection tools; ask the user only for consequential preferences or scope choices that the code cannot answer.",
      "Ground the plan in inspected code. State the requested outcome, agreed decisions, existing patterns to reuse, ordered changes, and an observable check of success. Distinguish verified facts, assumptions, and unresolved decisions.",
      "Resolve decisions that affect implementation before presenting the plan as ready. Keep implementation details proportional to the change; omit sections that add no decision or evidence.",
      "Keep the latest agreed decisions and any unresolved choices clear in the conversation so implementation can continue from them. An exploratory suggestion or saved plan is not approval to implement.",
    ],
    shellGuidance: [
      "Prefer dedicated read-only tools for inspection. Use available read_file for text and directories, glob_files for paths, grep_search for contents, git_inspect for Git status and diffs, and read_database for SQLite.",
      "Plan shell access uses a conservative allowlist: a command that looks read-only may still be rejected. Use the shell reported in Environment and simple supported inspection commands.",
      "For POSIX shells, examples are pwd, ls, cat, head, rg, git status, and git diff. For PowerShell, examples are Get-Location, Get-ChildItem, Get-Content, Select-String, git status, and git diff.",
      "In PowerShell, use Sort-Object, Select-Object, Format-Table, or Format-List with literal properties. For example: Get-ChildItem -File | Sort-Object Length -Descending | Select-Object -First 20 Name,Length.",
      "Do not run interpreters or arbitrary code, database CLIs, tests, builds, package scripts, installs, or development servers in Plan mode. Do not use command substitution, redirection, heredocs, multiline scripts, or background jobs.",
      "After a Plan permission denial, use an available dedicated read-only tool rather than retrying the same operation through another shell, interpreter, or wrapper. If verification requires execution that Plan does not permit, explain that limit and continue the read-only investigation.",
    ],
    toolPolicy: "read-only",
    fullAccess: false,
    enforceTodos: false,
    nudges: 0,
    advisor: false,
    subagents: true,
    defaultSteps: 0,
  },
  build: {
    label: "BUILD",
    hint: "implement and verify",
    prompt: [],
    compactPrompt: "",
    finalReminder: "",
    workflowGuidance: [
      "For authorized implementation, work through the requested outcome, relevant code, focused changes, and verification. A mode switch alone is not permission to implement; answer discussion or review requests without editing.",
      "Carry forward the latest agreed decisions from the conversation or a user-designated plan. Read that plan if its content is unavailable. Reopen a decision only if the user changes it or current evidence contradicts it; explain the conflict.",
      "Read the relevant code and reuse its patterns. Keep small fixes direct; use a short task list only when dependencies or scope need tracking. Do not require a plan file or a planning round before a straightforward change.",
      "Prove the changed behavior with a focused check and run required repository checks. Reuse passing evidence until a relevant change or new uncertainty requires another check.",
      "Finish when the requested behavior is supported by evidence. Report material limits; leave optional cleanup, tuning, and unrelated improvements for a separate request.",
    ],
    toolPolicy: "all",
    fullAccess: true,
    enforceTodos: false,
    nudges: 0,
    advisor: false,
    subagents: true,
    defaultSteps: 0,
  },
  ultrawork: {
    label: "ULTRAWORK",
    hint: "finish autonomously",
    prompt: [
      "You are in ULTRAWORK mode.",
      "Use this mode for sustained work across related stages: carry the user's authorized outcomes through implementation, integration, and verification. Discussion, study, and review requests remain read-only unless the user asks for changes.",
      "Carry forward the latest agreed decisions. Track required work with todo_write, update it as evidence arrives, and do not stop while required work is pending or in progress. Keep optional improvements out of the required todo list.",
      "Follow the selected delegation policy. Honor explicit requests for subagents within available tools, model routing, and permissions; prompt length, task size, or file count alone must not veto them. For automatic delegation, use spawn_subagents when independent results justify setup and integration cost, and the task board (task_create, task_list) to track dispatched work. A worker is not required on every task.",
      "Integrate required worker results and prove the requested behavior. Run required repository checks and focused checks for changed behavior; reuse passing evidence rather than repeating verification after each status review.",
      "Fix failures that affect the requested outcome. Once required work is verified, finish; do not pursue perfection, speculative hardening, or another audit. If a required outcome is blocked, report the evidence and missing prerequisite honestly rather than marking it complete or retrying without new information.",
      "Reply with a short final summary that names the changes and the checks that passed.",
    ],
    compactPrompt: "You are in ultrawork mode: finish the authorized outcomes, track required work, follow delegation policy, and stop when the evidence is sufficient. Report blockers honestly; optional improvements are separate work.",
    finalReminder:
      "Current mode: ULTRAWORK. Review existing evidence against the requested outcomes and update the todo list. Continue only for required unfinished work; do not repeat passed checks just because of this reminder. If complete, deliver the final summary. If blocked, report the missing prerequisite and unverified work honestly.",
    toolPolicy: "all",
    fullAccess: true,
    enforceTodos: true,
    nudges: 2,
    advisor: true,
    subagents: true,
    defaultSteps: 0,
  },
};

/**
 * Resolves the step budget for one turn. An explicit programmatic cap wins,
 * then the user's mode config, then the mode contract default. 0 means
 * unlimited at every level.
 */
export function modeStepLimit(
  mode: AgentMode,
  configuredSteps?: number,
  explicitMaxTurns = 0,
): number {
  if (explicitMaxTurns > 0) return explicitMaxTurns;
  if (configuredSteps !== undefined) return configuredSteps;
  return modeContract(mode).defaultSteps;
}

export function modeContract(mode: AgentMode): ModeContract {
  return MODE_CONTRACTS[mode] ?? MODE_CONTRACTS.build;
}

export function modeTransitionReminder(from: AgentMode, to: AgentMode): string {
  return [
    `The user switched this session from ${from.toUpperCase()} to ${to.toUpperCase()} mode.`,
    `The previous ${from.toUpperCase()} mode instructions no longer apply.`,
    `Continue in ${to.toUpperCase()} mode.`,
    "Do not tell the user to switch modes, press Tab, or run /build; the switch already happened.",
    "Retain the user's latest agreed decisions and unresolved questions. Switching modes does not approve a draft, authorize edits, or request additional work.",
    ...(to === "ultrawork" ? modeContract(to).prompt : []),
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
