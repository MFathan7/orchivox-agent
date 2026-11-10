import { composeSystemParts, composeSystemPrompt } from "./composer";
import type { SystemPromptOptions } from "./types";
import type { SystemPart } from "../../types/schema";

export type { SystemPromptOptions } from "./types";
export { backgroundRequest, RECAP_INSTRUCTION, TITLE_INSTRUCTION } from "./background";
export { MODE_PROMPTS } from "./base";
export { progressCheckpointMessage } from "./progress";

export function buildSystemPrompt(options: SystemPromptOptions): string {
  return composeSystemPrompt(options);
}

export function buildSystemParts(options: SystemPromptOptions): SystemPart[] {
  return composeSystemParts(options);
}
