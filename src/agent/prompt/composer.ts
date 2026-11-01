import { agentPromptPart } from "./agent-prompt";
import { closingPart, modeAdditionPart, specialistPart } from "./base";
import {
  environmentPart,
  extraPart,
  projectPart,
  rulesPart,
  skillsPart,
} from "./instructions";
import { applyPromptProfile, selectPromptProfile } from "./profiles";
import type { PromptPart, SystemPromptOptions } from "./types";
import type { SystemPart } from "../../types/schema";

function clean(parts: Array<PromptPart | undefined>): PromptPart[] {
  return parts.filter((part): part is PromptPart => Boolean(part && part.text.trim().length > 0));
}

export function composePromptParts(options: SystemPromptOptions): PromptPart[] {
  const includeInstructions = options.includeInstructions !== false;
  const profile = selectPromptProfile({
    providerKind: options.providerKind,
    model: options.model,
  });
  return applyPromptProfile(
    clean([
      agentPromptPart(options, profile),
      includeInstructions ? environmentPart(options) : undefined,
      includeInstructions ? projectPart(options) : undefined,
      includeInstructions ? rulesPart(options) : undefined,
      specialistPart(options),
      modeAdditionPart(options),
      includeInstructions ? skillsPart(options) : undefined,
      extraPart(options),
      options.includeClosing === false ? undefined : closingPart(options),
    ]),
    profile,
  );
}

export function composeCompactPromptParts(options: SystemPromptOptions): PromptPart[] {
  return composePromptParts(options);
}

export function composeSystemParts(options: SystemPromptOptions): SystemPart[] {
  const parts = options.compact
    ? composeCompactPromptParts(options)
    : composePromptParts(options);
  let cacheIndex = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].stable) cacheIndex = index;
  }
  return parts.map((part, index) => ({
    text: part.text.trim(),
    ...(index === cacheIndex ? { cache: true } : {}),
  }));
}

export function composeSystemPrompt(options: SystemPromptOptions): string {
  return composeSystemParts(options)
    .map((part) => part.text)
    .join("\n\n");
}
