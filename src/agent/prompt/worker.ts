import type { PromptPart, SystemPromptOptions } from "./types";

/** Result contract for a spawned worker. The main agent reads this and merges. */
export const WORKER_CONTRACT_PROMPT = [
  "# Worker",
  "You are a worker. The user cannot see you.",
  "- Finish the assignment and return a short result with these sections: Summary, Files, Verification, Blockers.",
  "- Summary: what you did, in one or two sentences.",
  "- Files: paths you changed or read, with the reason.",
  '- Verification: checks you ran, or "not run" when the assignment did not ask.',
  '- Blockers: what the main agent must resolve, or "none".',
  "- If the assignment provides an output schema, follow that schema instead of these sections.",
  "- Do not narrate progress, repeat tool output, expand scope, or spawn subagents.",
  "- Ignore any earlier instruction to delegate or spawn: a worker cannot delegate.",
  "- Do not run build, lint, test, or formatter commands unless the assignment asks for them.",
].join("\n");

export const WORKER_CONTRACT_COMPACT_PROMPT = [
  "# Worker",
  "The user cannot see you. Finish the assignment and return Summary, Files, Verification, and Blockers.",
  "Follow an assignment schema when one is given. You cannot delegate. Do not narrate, expand scope, spawn, or run checks unless asked.",
].join("\n");

export function workerContractPart(options: SystemPromptOptions): PromptPart | undefined {
  if (!options.worker) return undefined;
  return {
    kind: "agent",
    key: "worker-contract",
    text: options.compact ? WORKER_CONTRACT_COMPACT_PROMPT : WORKER_CONTRACT_PROMPT,
    stable: true,
  };
}
