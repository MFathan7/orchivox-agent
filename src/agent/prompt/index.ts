import { composeSystemParts, composeSystemPrompt } from "./composer";
import type { SystemPromptOptions } from "./types";
import type { SystemPart } from "../../types/schema";

export type { SystemPromptOptions } from "./types";
export { backgroundRequest, RECAP_INSTRUCTION, TITLE_INSTRUCTION } from "./background";
export { btwRequest } from "./btw";
export { MODE_PROMPTS } from "./base";
export { progressCheckpointMessage } from "./progress";
export { toolArgumentRecoveryMessage } from "./tool-recovery";
export { skillAvailabilityHint, SKILL_OUTPUT_CORRECTION } from "./skills";
export { workerStepBudgetNotice } from "./worker";

export function buildSystemPrompt(options: SystemPromptOptions): string {
  return composeSystemPrompt(options);
}

export function buildSystemParts(options: SystemPromptOptions): SystemPart[] {
  return composeSystemParts(options);
}
