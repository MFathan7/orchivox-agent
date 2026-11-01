import { composeSystemParts, composeSystemPrompt } from "./composer";
import type { SystemPromptOptions } from "./types";
import type { SystemPart } from "../../types/schema";

export type { SystemPromptOptions } from "./types";
export { MODE_PROMPTS } from "./base";

export function buildSystemPrompt(options: SystemPromptOptions): string {
  return composeSystemPrompt(options);
}

export function buildSystemParts(options: SystemPromptOptions): SystemPart[] {
  return composeSystemParts(options);
}
