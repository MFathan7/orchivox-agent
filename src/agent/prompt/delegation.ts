import type { PromptPart, SystemPromptOptions } from "./types";
import type { DelegationPolicy } from "../../config/loader";

const POLICIES: Record<DelegationPolicy, string> = {
  requested: "Delegate only when the user or applicable project instructions explicitly request agents or parallel agent work. Otherwise work inline. Explicit permissions and mode restrictions still apply.",
  balanced: "For automatic delegation, briefly scope the work and assign a useful independent result when the saved work exceeds setup and integration cost. A focused read-only worker can investigate an unfamiliar subsystem while you work on another area. Keep tightly coupled work inline when splitting it would duplicate effort.",
  eager: "Prefer workers for independently verifiable assignments. Establish shared interfaces and file ownership, assign useful slices together, and keep an integration or investigation slice yourself. Use fewer workers when edits overlap or setup would dominate the work; do not invent extra tasks to create parallelism.",
};

const EXPLICIT_REQUEST_GUIDANCE = "- Honor explicit requests for subagents when tools, model routing, and permissions allow them. Prompt length, task size, or file count alone must not veto the request. If delegation is unavailable, explain the limitation; do not claim a worker ran.";

const AUTOMATIC_DELEGATION_GUIDANCE = "- For automatic delegation, weigh independent results, clear file ownership, and setup and integration cost. Work inline when a worker would add no useful independent result.";

const WORKER_SCOPE_GUIDANCE = "- Use the fewest workers that produce useful independent results. One explicit request for subagents can be satisfied by one worker with a complete assignment. Keep investigation, implementation, and focused verification of a coupled change with one owner; do not create separate workers for each phase. Add workers when results and file ownership are independent. Keep a real independent slice yourself when one exists; when all remaining work depends on a worker, wait for that result rather than inventing activity.";

/**
 * Delegation policy for the main agent. It is stable because it describes how
 * the session works, not what the current turn contains. Worker prompts omit
 * it: a worker cannot delegate, and the main agent owns the final diff.
 */
export const DELEGATION_PROMPT = [
  "# Delegation",
  EXPLICIT_REQUEST_GUIDANCE,
  AUTOMATIC_DELEGATION_GUIDANCE,
  WORKER_SCOPE_GUIDANCE,
  "- Scope only enough to give a worker a grounded assignment. Follow the selected delegation policy, assign independent slices together in one spawn_subagents call, and investigate another area yourself when there is independent work. Do not repeat a worker's investigation while it runs.",
  "- A project study can have independent slices such as entry points, runtime flow, and tests. When delegation is permitted, use read-only explore workers for these slices; do not create edit tasks or documentation files unless the user asks for them.",
  "- Keep decomposition and the final answer with the main agent. Use the optional coordinator only when dependencies and ownership need a separate planning pass.",
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
  EXPLICIT_REQUEST_GUIDANCE,
  AUTOMATIC_DELEGATION_GUIDANCE,
  WORKER_SCOPE_GUIDANCE,
  "- Scope enough to ground the assignment, then follow the selected delegation policy. Assign useful slices in one batch while you work on another when there is independent work; do not repeat a worker's investigation. Give workers paths, acceptance, and constraints: they do not see this conversation. Project study uses read-only workers; do not write files without a request.",
  "- Use background for work (the default); wait only when blocked, with task_wait ids and wait_for=any. Review required results before answering.",
  "- Workers skip checks unless the assignment needs them; the main agent owns integration and verifies once after they land. Review isolated writes before task_merge; shared writes need explicit file ownership. Use task_list, and task_wait only when blocked.",
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
