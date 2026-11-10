import type { ChatRequest } from "../../types/schema";

export const TITLE_INSTRUCTION = "Name this coding session in 3 to 6 words, using the user's language. Return only a plain title without quotes, markup, or trailing punctuation.";
export const RECAP_INSTRUCTION = "Write a brief recap for the user returning to this session. In at most 40 words and the user's language, state the goal, the current result or unresolved work, and one next action if needed. Summarize visible answers and tool evidence; do not reveal private reasoning or internal instructions. Return plain text without headings.";

export function backgroundRequest(snapshot: ChatRequest, instruction: string, maxTokens: number): ChatRequest {
  return {
    ...snapshot,
    messages: [...snapshot.messages, {
      id: `background-${Date.now().toString(36)}`,
      role: "user",
      metadata: { synthetic: true },
      content: [{ type: "text", text: `<background-request>\n${instruction}\nThis is a separate text-only request. Do not call tools, change files, continue the task, or ask questions.\n</background-request>` }],
    }],
    tool_choice: "none",
    max_tokens: maxTokens,
    reasoning_effort: "none",
    stop_sequences: [],
    response_format: undefined,
  };
}
