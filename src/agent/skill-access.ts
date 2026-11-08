import { normalizeSkillName } from "./skills";
import type { SpecialistAgentProfile } from "./specialist-agents";

export interface SubagentSkillAccess {
  policy: "all" | "listed" | "none";
  allowed: string[];
  preload: string[];
  dropped: string[];
}

function uniqueSkillNames(names: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names ?? []) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = normalizeSkillName(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/**
 * Resolves the skill boundary for one agent. A task can narrow a profile's
 * allowlist, but it can never widen it. A `none` profile always wins.
 */
export function resolveSubagentSkillAccess(
  specialist: SpecialistAgentProfile | undefined,
  requested: readonly string[] | undefined,
): SubagentSkillAccess {
  const requestedNames = uniqueSkillNames(requested);
  const policy = specialist?.skillPolicy ?? "all";
  if (policy === "none") {
    return { policy: "none", allowed: [], preload: [], dropped: requestedNames };
  }

  const profilePreload = uniqueSkillNames(specialist?.preloadSkills);
  if (policy === "listed") {
    const profileNames = uniqueSkillNames(specialist?.skills);
    const profileKeys = new Set(profileNames.map(normalizeSkillName));
    const allowed =
      requestedNames.length > 0
        ? requestedNames.filter((name) => profileKeys.has(normalizeSkillName(name)))
        : profileNames;
    const allowedKeys = new Set(allowed.map(normalizeSkillName));
    const dropped = requestedNames.filter(
      (name) => !allowedKeys.has(normalizeSkillName(name)),
    );
    const preload = profilePreload.filter((name) =>
      allowedKeys.has(normalizeSkillName(name)),
    );
    return { policy: "listed", allowed, preload, dropped };
  }

  if (requestedNames.length > 0) {
    const allowedKeys = new Set(requestedNames.map(normalizeSkillName));
    return {
      policy: "listed",
      allowed: requestedNames,
      preload: profilePreload.filter((name) =>
        allowedKeys.has(normalizeSkillName(name)),
      ),
      dropped: [],
    };
  }

  return { policy: "all", allowed: [], preload: profilePreload, dropped: [] };
}
