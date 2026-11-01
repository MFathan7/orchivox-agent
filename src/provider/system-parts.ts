import type { ChatRequest, SystemPart } from "../types/schema";

/**
 * Prefers ordered system parts. Falls back to the single compatibility string
 * so callers that never adopted `system_parts` keep the old payload.
 */
export function requestSystemParts(request: ChatRequest): SystemPart[] {
  if (request.system_parts && request.system_parts.length > 0) return request.system_parts;
  return request.system ? [{ text: request.system }] : [];
}

export function joinedSystemText(request: ChatRequest): string | undefined {
  const parts = requestSystemParts(request);
  if (parts.length === 0) return undefined;
  return parts.map((part) => part.text).join("\n\n");
}
