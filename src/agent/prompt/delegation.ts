import type { PromptPart, SystemPromptOptions } from "./types";
import type { DelegationPolicy } from "../../config/loader";

const POLICIES: Record<DelegationPolicy, string> = {
  requested: "Delegate only when the user or applicable project instructions explicitly request agents or parallel agent work. Otherwise work inline. Explicit permissions and mode restrictions still apply.",
  balanced: "For automatic delegation, briefly scope the work and assign a useful independent result when the saved work exceeds setup and integration cost. A focused read-only worker can investigate an unfamiliar subsystem while you work on another area. Keep tightly coupled work inline when splitting it would duplicate effort.",
  eager: "During initial scoping, look for independently verifiable work. As soon as you can name the target and expected result, dispatch those slices in one background batch before doing their detailed investigation yourself. Keep a slice that can proceed while the workers run, when one exists. If write ownership is still unclear, delegate a focused read-only question while you resolve it.",
};

const EXPLICIT_REQUEST_GUIDANCE = "- Honor explicit requests for subagents when tools, model routing, and permissions allow them. Prompt length, task size, or file count alone must not veto the request. If delegation is unavailable, explain the limitation; do not claim a worker ran.";

const WORKER_COST_GUIDANCE = "- Give each worker a bounded assignment with paths, an expected result, and relevant constraints. Use the Fast role when configured for focused searches and read-only checks. Use a deeper model for work that needs it. Assign each file one owner and run shared verification once from the main checkout.";

const WORKER_SCOPE_GUIDANCE = "- Use the fewest workers that produce useful independent results. Keep a coupled change with one owner. In Plan, assign read-only work. Study and review also use read-only workers unless the user requests edits and the mode allows them. Include the context each worker needs in its assignment.";

const BACKGROUND_GUIDANCE = "- Use spawn_subagents in background mode for independent assignments. Work on your own slice before calling task_wait. When blocked, wait for the required ids with wait_for=any and integrate each result as it arrives. Use wait_for=all only when the next step needs every result.";

/**
 * Delegation policy for the main agent. It is stable because it describes how
 * the session works, not what the current turn contains. Worker prompts omit
 * it: a worker cannot delegate, and the main agent owns the final diff.
 */
const DELEGATION_PROMPT = [
  EXPLICIT_REQUEST_GUIDANCE,
  WORKER_SCOPE_GUIDANCE,
  WORKER_COST_GUIDANCE,
  BACKGROUND_GUIDANCE,
  "- Keep decomposition and the final answer with the main agent. Use the optional coordinator only when dependencies and ownership need a separate planning pass.",
  "- Use blocking parallel mode when the next step needs the whole batch. Use chain only for a real dependency.",
  "- Use task_list when you need worker or task status. Keep new reads and edits focused on work that has no active owner.",
  "- Review required worker results before answering. Inspect partial results on failure and assign or complete the remaining work. Review isolated writes before task_merge. Run shared build, lint, test, and format checks during integration unless a worker's assignment requires a focused check.",
].join("\n");

const DELEGATION_COMPACT_PROMPT = [
  EXPLICIT_REQUEST_GUIDANCE,
  WORKER_SCOPE_GUIDANCE,
  WORKER_COST_GUIDANCE,
  BACKGROUND_GUIDANCE,
  "- Use task_list for status. Review required results before answering and isolated writes before task_merge.",
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
    text: `# Delegation\n- ${POLICIES[options.delegation ?? "balanced"]}\n${options.compact ? DELEGATION_COMPACT_PROMPT : DELEGATION_PROMPT}`,
    stable: true,
  };
}
