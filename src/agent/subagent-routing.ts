import type { ProviderRouter } from "../provider/router";
import type { SpecialistAgentRegistry } from "./specialist-agents";
import { SubagentReadinessError, type SubagentSpawnTask } from "./subagent";

export async function prepareSubagentRoute(
  task: SubagentSpawnTask,
  agents: SpecialistAgentRegistry,
  router: ProviderRouter,
): Promise<SubagentSpawnTask> {
  const specialist = task.agent ? await agents.getAgent(task.agent) : undefined;
  if (task.agent && !specialist) {
    throw new SubagentReadinessError("unknown_specialist", `Unknown specialist "${task.agent}".`);
  }
  const mode = specialist?.readOnly ? "plan" : task.mode ?? "build";
  const role = task.roleModel ?? specialist?.roleModel;
  if (role !== undefined && role !== "main" && role !== "fast" && role !== "advisor") {
    throw new SubagentReadinessError("invalid_model_role", `Unknown model role "${role}".`);
  }
  if (Boolean(task.provider) !== Boolean(task.model)) {
    throw new SubagentReadinessError("incomplete_model_route", "Specify both provider and model for an explicit worker route.");
  }
  const ref = task.provider && task.model ? { provider: task.provider, model: task.model }
    : role ? router.getRole(role) : router.getModeModel(mode);
  if (!ref) {
    const requested = role ?? "main";
    throw new SubagentReadinessError("model_role_unconfigured",
      `no model assigned for role "${requested}" in the config roles section. Configure roles.${requested}_model in /models before using ${specialist ? `@${specialist.name}` : "this worker"}.`,
      { agent: specialist?.name ?? task.agent, roleModel: requested, mode });
  }
  try {
    router.provider(ref.provider, ref.model);
  } catch (error) {
    throw new SubagentReadinessError("model_route_unavailable", error instanceof Error ? error.message : String(error),
      { agent: specialist?.name ?? task.agent, roleModel: role, ...ref, mode });
  }
  return { ...task, agent: specialist?.name ?? task.agent, mode, roleModel: role,
    provider: ref.provider, model: ref.model, writeIsolation: mode === "plan" ? false : task.writeIsolation };
}
