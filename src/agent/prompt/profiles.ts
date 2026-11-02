import type { PromptPart } from "./types";

export interface PromptProfileMatch {
  providerKind?: string;
  /** Regular expression matched against the model id. */
  modelPattern?: string;
}

export interface PromptProfile {
  id: string;
  match: PromptProfileMatch;
  /** Replace the base prompt or append text after it. */
  mode: "append" | "override";
  text?: string;
  removeKeys?: string[];
}

export const DEFAULT_PROMPT_PROFILE: PromptProfile = {
  id: "default",
  match: {},
  mode: "override",
};

// Evidence gate: add a model-specific profile only after `observe:turn` records
// a concrete over-verification case, and add a regression test with it.
export const PROMPT_PROFILES: PromptProfile[] = [DEFAULT_PROMPT_PROFILE];

export function selectPromptProfile(
  input: { providerKind?: string; model?: string },
  profiles: PromptProfile[] = PROMPT_PROFILES,
): PromptProfile {
  for (const profile of profiles) {
    if (profile.id === DEFAULT_PROMPT_PROFILE.id) continue;
    if (matchesProfile(profile, input)) return profile;
  }
  return profiles.find((profile) => profile.id === DEFAULT_PROMPT_PROFILE.id) ?? DEFAULT_PROMPT_PROFILE;
}

export function applyPromptProfile(parts: PromptPart[], profile: PromptProfile): PromptPart[] {
  const removed = new Set(profile.removeKeys ?? []);
  if (removed.size === 0) return parts;
  return parts.filter((part) => !removed.has(part.key));
}

function matchesProfile(
  profile: PromptProfile,
  input: { providerKind?: string; model?: string },
): boolean {
  if (profile.match.providerKind !== undefined) {
    if (profile.match.providerKind.toLowerCase() !== input.providerKind?.toLowerCase()) return false;
  }
  if (profile.match.modelPattern !== undefined) {
    if (!input.model) return false;
    try {
      if (!new RegExp(profile.match.modelPattern, "i").test(input.model)) return false;
    } catch {
      return false;
    }
  }
  return true;
}
