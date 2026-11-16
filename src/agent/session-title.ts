import type { LLMProvider } from "../provider/router";
import { ChatRequestSchema, type Message } from "../types/schema";
import { SESSION_TITLE_SYSTEM } from "./prompt/background";

const PLACEHOLDER_TITLE = /^(?:\(?unknown\)?|untitled|new (?:chat|session)|session|n\/a|none)$/i;

export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLE.test(title.trim());
}

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

function visibleTitleOutput(raw: string): string {
  const markers = /<\s*(\/?)\s*(think|thinking|reasoning|analysis)\b[^>]*>|\[(\/?)(think|thinking|reasoning|analysis)\]|```(?:[ \t]*(thinking|reasoning|analysis)\b[^\n]*(?:\r?\n|$))?/gi;
  const stack: string[] = [];
  let visible = "", cursor = 0;
  for (const marker of raw.matchAll(markers)) {
    if (!stack.length) visible += raw.slice(cursor, marker.index);
    const token = marker[0];
    if (stack.at(-1) === "fence") {
      if (token === "```") stack.pop();
    } else if (marker[5]) stack.push("fence");
    else if (token === "```") { if (!stack.length) visible += token; }
    else {
      const name = (marker[2] ?? marker[4]).toLowerCase();
      if (marker[1] || marker[3]) { if (stack.at(-1) === name) stack.pop(); }
      else if (!token.endsWith("/>")) stack.push(name);
    }
    cursor = marker.index! + token.length;
  }
  if (!stack.length) visible += raw.slice(cursor);
  return visible.trim();
}

export function normalizeTitle(raw: string, maxChars = 60): string | undefined {
  const visible = visibleTitleOutput(raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""));
  const marked = /<(session_title|title)\s*>([\s\S]*?)<\/\1\s*>/i.exec(visible);
  let candidate = marked ? marked[2].trim() : visible;
  if (/<\/?(?:session_title|title)\b/i.test(candidate)) return undefined;
  candidate = candidate.replace(/^```(?:json|text)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
  if (candidate.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || !("title" in parsed) || typeof parsed.title !== "string") return undefined;
      candidate = visibleTitleOutput(parsed.title);
    } catch { return undefined; }
  }
  if (!candidate || /[<>\u0000-\u001f\u007f-\u009f]/.test(candidate)) return undefined;

  let title = candidate
    .replace(/^#+\s*/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\*\*/g, "")
    .replace(/~~/g, "")
    .replace(/[.;:,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!title) return undefined;
  if (PLACEHOLDER_TITLE.test(title)) return undefined;
  if (title.length > maxChars) {
    title = `${title.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
  }
  return title;
}

export async function generateSessionTitle(options: SessionTitleOptions): Promise<string | undefined> {
  const firstUser = options.messages.find(
    (message) =>
      message.role === "user" &&
      message.metadata?.synthetic !== true &&
      messageText(message).length > 0,
  );
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
    system: SESSION_TITLE_SYSTEM,
    messages: [{ id: "session-title", role: "user", content: [{ type: "text", text: prompt }] }],
    max_tokens: 128,
    temperature: 0,
    reasoning_effort: "none",
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
