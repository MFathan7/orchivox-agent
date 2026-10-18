import type { LLMProvider } from "../provider/router";
import { ChatRequestSchema, type Message } from "../types/schema";

const TITLE_SYSTEM = [
  "You write concise session titles for a coding assistant.",
  "Reply with one short title of 3 to 6 words.",
  "Use plain text. No quotes, no markdown, no trailing punctuation.",
].join(" ");

export interface SessionTitleOptions {
  messages: Message[];
  provider: LLMProvider;
  maxChars?: number;
  signal?: AbortSignal;
}

export function messageText(message: Message): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join(" ").trim();
}

export function normalizeTitle(raw: string, maxChars = 60): string | undefined {
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;

  let title = firstLine
    .replace(/^#+\s*/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\*\*/g, "")
    .replace(/~~/g, "")
    .replace(/[.;:,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title) return undefined;
  if (title.length > maxChars) {
    title = `${title.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
  }
  return title;
}

export async function generateSessionTitle(options: SessionTitleOptions): Promise<string | undefined> {
  const firstUser = options.messages.find((message) => message.role === "user" && messageText(message).length > 0);
  if (!firstUser) return undefined;

  const firstAssistant = options.messages.find(
    (message) => message.role === "assistant" && messageText(message).length > 0,
  );
  const userText = truncate(messageText(firstUser), 2000);
  const assistantText = firstAssistant ? truncate(messageText(firstAssistant), 2000) : "";
  const prompt = assistantText
    ? `First user message:\n${userText}\n\nFirst assistant reply:\n${assistantText}`
    : `First user message:\n${userText}`;

  const request = ChatRequestSchema.parse({
    system: TITLE_SYSTEM,
    messages: [{ id: "session-title", role: "user", content: [{ type: "text", text: prompt }] }],
    max_tokens: 48,
    temperature: 0.2,
  });

  try {
    let text = "";
    let streamError: string | undefined;
    for await (const event of options.provider.streamChat(request, options.signal)) {
      if (event.type === "token") text += event.text;
      else if (event.type === "error") streamError = event.message;
    }
    if (streamError) return undefined;
    return normalizeTitle(text, options.maxChars ?? 60);
  } catch {
    return undefined;
  }
}

function truncate(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 3).trimEnd()}...`;
}
