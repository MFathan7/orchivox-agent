import type { PromptPart, SystemPromptOptions } from "./types";
import type { DelegationPolicy } from "../../config/loader";

const POLICIES: Record<DelegationPolicy, string> = {
  requested: "Delegate only when the user or applicable project instructions explicitly request agents or parallel agent work. Otherwise work inline. Explicit permissions and mode restrictions still apply.",
  balanced: "After a brief local scope check, delegate substantial independent slices when the saved work exceeds the setup and integration cost. For an unfamiliar subsystem, a focused read-only worker can map it while you investigate another area. Keep familiar or tightly coupled work inline.",
  eager: "Prefer workers for substantial independent slices of multi-file work or project study. Scope shared interfaces first, assign the slices together, and keep an integration or investigation slice yourself. Use fewer workers when edits share the same files or setup would dominate the work.",
};

/**
 * Delegation policy for the main agent. It is stable because it describes how
 * the session works, not what the current turn contains. Worker prompts omit
 * it: a worker cannot delegate, and the main agent owns the final diff.
 */
export const DELEGATION_PROMPT = [
  "# Delegation",
  "- Do the work yourself when it is a direct answer, one file, a small focused edit, a command the user asked for, or cleanup such as formatting and comment trims.",
  "- Scope the request with a small batch of local searches. When the selected delegation policy permits it and several substantial areas can be investigated independently, assign focused workers in one spawn_subagents call and investigate another area yourself.",
  "- A project study can have independent slices such as entry points, runtime flow, and tests. When delegation is permitted, use read-only explore workers for these slices; do not create edit tasks or documentation files unless the user asks for them.",
  "- Keep decomposition and the final answer with the main agent. Do not delegate a direct answer or a job you can finish in a few calls. Use the optional coordinator only when dependencies and ownership need a separate planning pass.",
  "- Prefer one worker that can investigate and edit over a chain of handoffs. Shared edits need one integration owner.",
  "- Use background mode (the default) and keep working. Use explicit parallel mode only when the next step requires the whole batch, and chain only for true dependencies.",
  "- Give every worker a self-contained brief: target files, required change, acceptance, constraints, and the interfaces it must preserve. Workers do not see this conversation.",
  "- Tell workers to skip build, lint, test, and formatter runs unless the assignment needs them. You verify once after the workers land.",
  "- Use task_list for workers and board tasks. When blocked, use task_wait with the required ids and wait_for=any to consume the first result; use wait_for=all only when every result is required. Do not poll or repeat a worker's investigation while it runs.",
  "- Review required worker results before the final answer. If a worker fails, use its error and partial evidence to finish the request or report what remains unverified. Never claim that pending work is complete.",
  "- Isolated writes require review and task_merge with the worker id. Shared writes need explicit file ownership. The main agent owns integration and verifies once.",
].join("\n");

export const DELEGATION_COMPACT_PROMPT = [
  "# Delegation",
  "- Work inline for direct answers, single-file or small edits, requested commands, and cleanup.",
  "- Scope locally, then follow the selected delegation policy for independent substantial slices. Assign permitted slices in one batch while you work on another. Project study uses read-only workers; do not write files without a request.",
  "- Use background for work (the default); wait only when blocked, with task_wait ids and wait_for=any. Review required results before answering.",
  "- Workers skip checks; verify once after they land. Use task_list, and task_wait only when blocked.",
].join("\n");

export function delegationPart(options: SystemPromptOptions): PromptPart | undefined {
  if (options.worker) return undefined;
  if (options.tools) {
    const hasDelegationTool =
      options.tools.includes("spawn_subagents") || options.tools.includes("task_create");
    if (!hasDelegationTool) return undefined;
  }
  return {
    kind: "agent",
    key: "delegation",
    text: `${options.compact ? DELEGATION_COMPACT_PROMPT : DELEGATION_PROMPT}\n- ${POLICIES[options.delegation ?? "balanced"]}`,
    stable: true,
  };
}
