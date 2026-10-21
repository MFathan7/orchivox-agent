import { z } from "zod";

import type { ModelCapabilities, ProviderKind } from "../config/loader";
import {
  computeCostUsd,
  toolParametersToJsonSchema,
  type ChatRequest,
  type FinishReason,
  type StreamEvent,
  type TextBlock,
  type TokenPricing,
} from "../types/schema";
import { learnLimitsFromError } from "./limit-cache";
import type { LLMProvider } from "./router";
import { iterateSse } from "./sse";

export interface OpenAICompatProviderOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  model?: string;
  pricing?: TokenPricing;
  kind: ProviderKind;
  capabilities: ModelCapabilities;
}

const OpenAiToolCallFragmentSchema = z.object({
  index: z.number().int().nonnegative().default(0),
  id: z.string().nullish(),
  function: z
    .object({
      name: z.string().nullish(),
      arguments: z.string().nullish(),
    })
    .nullish(),
});

const OpenAiChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            reasoning_content: z.string().nullish(),
            reasoning: z.string().nullish(),
            thinking: z.string().nullish(),
            tool_calls: z.array(OpenAiToolCallFragmentSchema).nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .default([]),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().nullish(),
      completion_tokens: z.number().int().nonnegative().nullish(),
      total_tokens: z.number().int().nonnegative().nullish(),
      cost: z.number().nonnegative().nullish(),
      prompt_tokens_details: z
        .object({
          cached_tokens: z.number().int().nonnegative().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

const OpenAiModelsSchema = z.object({
  data: z.array(z.object({ id: z.string() })).default([]),
});

type OpenAiChunk = z.infer<typeof OpenAiChunkSchema>;
type OpenAiUsage = OpenAiChunk["usage"];
type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };
type OpenAiMessage = {
  role: string;
  content?: string | OpenAiContentPart[] | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
};

const FINISH_REASONS: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  function_call: "tool_calls",
  content_filter: "content_filter",
};

export class ThinkTagStreamParser {
  private inThink = false;
  private buffer = "";

  process(chunk: string): Array<{ type: "token" | "thinking_token"; text: string }> {
    const events: Array<{ type: "token" | "thinking_token"; text: string }> = [];
    this.buffer += chunk;

    while (this.buffer.length > 0) {
      if (!this.inThink) {
        const thinkIndex = this.buffer.toLowerCase().indexOf("<think>");
        const thinkingIndex = this.buffer.toLowerCase().indexOf("<thinking>");
        let matchIndex = -1;
        let tagLen = 0;
        if (thinkIndex !== -1 && (thinkingIndex === -1 || thinkIndex <= thinkingIndex)) {
          matchIndex = thinkIndex;
          tagLen = 7;
        } else if (thinkingIndex !== -1) {
          matchIndex = thinkingIndex;
          tagLen = 10;
        }

        if (matchIndex === -1) {
          const partialMatch = /<(?:t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?)?$/i.exec(this.buffer);
          if (partialMatch && partialMatch.index !== -1) {
            const emitText = this.buffer.slice(0, partialMatch.index);
            if (emitText.length > 0) events.push({ type: "token", text: emitText });
            this.buffer = this.buffer.slice(partialMatch.index);
            break;
          } else {
            events.push({ type: "token", text: this.buffer });
            this.buffer = "";
            break;
          }
        } else {
          const beforeTag = this.buffer.slice(0, matchIndex);
          if (beforeTag.length > 0) events.push({ type: "token", text: beforeTag });
          this.inThink = true;
          this.buffer = this.buffer.slice(matchIndex + tagLen);
        }
      } else {
        const endThinkIndex = this.buffer.toLowerCase().indexOf("</think>");
        const endThinkingIndex = this.buffer.toLowerCase().indexOf("</thinking>");
        let matchEndIndex = -1;
        let endTagLen = 0;
        if (endThinkIndex !== -1 && (endThinkingIndex === -1 || endThinkIndex <= endThinkingIndex)) {
          matchEndIndex = endThinkIndex;
          endTagLen = 8;
        } else if (endThinkingIndex !== -1) {
          matchEndIndex = endThinkingIndex;
          endTagLen = 11;
        }

        if (matchEndIndex === -1) {
          const partialEndMatch = /<\/(?:t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?)?$/i.exec(this.buffer);
          if (partialEndMatch && partialEndMatch.index !== -1) {
            const emitText = this.buffer.slice(0, partialEndMatch.index);
            if (emitText.length > 0) events.push({ type: "thinking_token", text: emitText });
            this.buffer = this.buffer.slice(partialEndMatch.index);
            break;
          } else {
            events.push({ type: "thinking_token", text: this.buffer });
            this.buffer = "";
            break;
          }
        } else {
          const insideText = this.buffer.slice(0, matchEndIndex);
          if (insideText.length > 0) events.push({ type: "thinking_token", text: insideText });
          this.inThink = false;
          this.buffer = this.buffer.slice(matchEndIndex + endTagLen);
        }
      }
    }
    return events;
  }

  flush(): Array<{ type: "token" | "thinking_token"; text: string }> {
    if (this.buffer.length === 0) return [];
    const event = {
      type: this.inThink ? ("thinking_token" as const) : ("token" as const),
      text: this.buffer,
    };
    this.buffer = "";
    return [event];
  }
}

export class OpenAICompatProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly extraHeaders: Record<string, string>;
  private readonly model: string | undefined;
  private readonly pricing: TokenPricing | undefined;
  private readonly kind: ProviderKind;
  private readonly capabilities: ModelCapabilities;
  private readonly unsupportedParams = new Set<string>();

  constructor(options: OpenAICompatProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.extraHeaders = options.headers ?? {};
    this.model = options.model;
    this.pricing = options.pricing;
    this.kind = options.kind;
    this.capabilities = options.capabilities;
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
    const model = req.model ?? this.model;
    if (!model) throw new Error("ChatRequest.model is required when the provider has no default model");

    const payload = buildChatPayload(req, model, this.kind, this.capabilities);
    for (const name of this.unsupportedParams) delete payload[name];

    let response: Response | undefined;
    let failureMessage = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.requestHeaders(),
          body: JSON.stringify(payload),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) {
          yield { type: "done", finish_reason: "aborted" };
          return;
        }
        yield { type: "error", code: "request_failed", message: errorMessage(error), recoverable: true };
        yield { type: "done", finish_reason: "error" };
        return;
      }

      if (response.ok) break;
      failureMessage = await readErrorBody(response);
      learnLimitsFromError(this.baseUrl, model, failureMessage);
      if (attempt >= 2) break;

      let adjusted = false;
      for (const name of unsupportedParameterNames(failureMessage)) {
        if (!(name in payload)) continue;
        delete payload[name];
        this.unsupportedParams.add(name);
        if (name.startsWith("reasoning")) this.capabilities.reasoning = false;
        adjusted = true;
      }
      if (!adjusted) {
        const nextMax = reducedMaxTokens(payload, failureMessage);
        if (nextMax !== undefined) {
          setPayloadMaxTokens(payload, nextMax);
          adjusted = true;
        }
      }
      if (!adjusted) break;
    }

    if (!response || !response.ok) {
      yield {
        type: "error",
        code: response ? `http_${response.status}` : "request_failed",
        message: failureMessage || "provider request failed",
        recoverable: false,
      };
      yield { type: "done", finish_reason: "error" };
      return;
    }
    if (!response.body) {
      yield {
        type: "error",
        code: "empty_body",
        message: "provider returned an empty response body",
        recoverable: false,
      };
      yield { type: "done", finish_reason: "error" };
      return;
    }

    const drafts = new Map<number, { id: string; name: string; argumentsText: string }>();
    const thinkParser = new ThinkTagStreamParser();
    let usage: OpenAiUsage;
    let finishReason: FinishReason | undefined;

    try {
      for await (const message of iterateSse(response.body, signal)) {
        if (message.data === "[DONE]") break;
        const chunk = OpenAiChunkSchema.safeParse(parseJson(message.data));
        if (!chunk.success) {
          yield {
            type: "error",
            code: "invalid_chunk",
            message: "provider sent a chat completion chunk that could not be parsed",
            recoverable: true,
          };
          continue;
        }
        if (chunk.data.usage) usage = chunk.data.usage;
        for (const choice of chunk.data.choices) {
          const delta = choice.delta;
          if (delta) {
            const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
            if (reasoning) yield { type: "thinking_token", text: reasoning };
            if (delta.content) {
              for (const event of thinkParser.process(delta.content)) {
                yield event;
              }
            }
            for (const fragment of delta.tool_calls ?? []) {
              const index = fragment.index;
              let draft = drafts.get(index);
              if (!draft) {
                draft = { id: fragment.id ?? `call_${index}`, name: "", argumentsText: "" };
                drafts.set(index, draft);
              }
              const nameFragment = fragment.function?.name ?? "";
              const argumentsFragment = fragment.function?.arguments ?? "";
              draft.name += nameFragment;
              draft.argumentsText += argumentsFragment;
              yield {
                type: "tool_call_delta",
                id: draft.id,
                index,
                name_delta: nameFragment,
                arguments_delta: argumentsFragment,
              };
            }
          }
          if (choice.finish_reason) finishReason = FINISH_REASONS[choice.finish_reason] ?? "stop";
        }
      }
      for (const event of thinkParser.flush()) {
        yield event;
      }
    } catch (error) {
      if (signal?.aborted) {
        yield { type: "done", finish_reason: "aborted" };
        return;
      }
      yield { type: "error", code: "stream_failed", message: errorMessage(error), recoverable: true };
      yield { type: "done", finish_reason: "error" };
      return;
    }

    if (signal?.aborted) {
      yield { type: "done", finish_reason: "aborted" };
      return;
    }

    for (const [index, draft] of [...drafts.entries()].sort(([a], [b]) => a - b)) {
      const toolArguments = parseToolArguments(draft.argumentsText);
      if (!toolArguments) {
        yield {
          type: "error",
          code: "tool_arguments_parse_error",
          message: `tool call "${draft.name || `call_${index}`}" sent invalid JSON arguments`,
          recoverable: true,
        };
        continue;
      }
      yield { type: "tool_call_ready", id: draft.id, name: draft.name, arguments: toolArguments };
    }

    const usageEvent = buildUsageEvent(usage, this.pricing);
    if (usageEvent) yield usageEvent;
    yield { type: "done", finish_reason: finishReason ?? (drafts.size > 0 ? "tool_calls" : "stop") };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/models`, { headers: this.requestHeaders(), signal });
    if (!response.ok) {
      throw new Error(`models request failed with status ${response.status}: ${await readErrorBody(response)}`);
    }
    const parsed = OpenAiModelsSchema.safeParse(parseJson(await response.text()));
    if (!parsed.success) throw new Error("models response did not match the expected shape");
    return parsed.data.data.map((model) => model.id);
  }

  private requestHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...this.extraHeaders,
    };
  }
}

export const buildOpenAiPayload = buildChatPayload;

export function buildChatPayload(
  req: ChatRequest,
  model: string,
  kind: ProviderKind,
  capabilities: ModelCapabilities,
): Record<string, unknown> {
  const basename = model.split("/").pop() ?? model;
  const reasoningFamily = capabilities.temperature === false || /^(o[1-9]|gpt-5)/i.test(basename);
  const payload: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(req, capabilities.vision ? "auto" : undefined),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (kind === "openai" && reasoningFamily) payload.max_completion_tokens = req.max_tokens;
  else payload.max_tokens = req.max_tokens;
  if (capabilities.temperature && !reasoningFamily) {
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.top_p !== undefined) payload.top_p = req.top_p;
  }
  if (req.stop_sequences.length > 0) payload.stop = req.stop_sequences;
  if (req.reasoning_effort && (capabilities.reasoning || kind === "ollama")) {
    const rawEffort = req.reasoning_effort.toLowerCase();
    const isNone = rawEffort === "off" || rawEffort === "none";
    const budgetMap: Record<string, number> = {
      low: 2048,
      medium: 8192,
      high: 16384,
      max: capabilities.reasoning_budget_max ?? 32768,
    };

    if (kind === "ollama") {
      if (isNone) {
        payload.chat_template_kwargs = { enable_thinking: false, thinking: false };
      } else if (rawEffort !== "default") {
        const effort = rawEffort === "max" ? "high" : rawEffort;
        payload.chat_template_kwargs = { enable_thinking: true, thinking: true };
        payload.reasoning_effort = effort;
        if (budgetMap[rawEffort]) {
          payload.reasoning_budget = budgetMap[rawEffort];
        }
      }
    } else if (kind === "openrouter") {
      if (isNone) {
        payload.reasoning = { effort: "none" };
      } else if (rawEffort !== "default") {
        payload.reasoning = { effort: rawEffort };
      }
    } else {
      if (isNone) {
        payload.reasoning_effort = "low";
      } else if (rawEffort !== "default") {
        payload.reasoning_effort = rawEffort === "max" ? "high" : rawEffort;
      }
    }
  }
  if (req.response_format && capabilities.structured_output) {
    payload.response_format = req.response_format;
  }
  if (req.tools.length > 0) {
    payload.tools = req.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toolParametersToJsonSchema(tool.parameters),
        ...(tool.strict ? { strict: true } : {}),
      },
    }));
    payload.tool_choice = req.tool_choice;
    if (capabilities.parallel_tool_calls) payload.parallel_tool_calls = true;
  }
  return payload;
}

export function toOpenAiMessages(
  req: ChatRequest,
  defaultImageDetail?: "auto" | "low" | "high",
): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });

  for (const message of req.messages) {
    if (message.role === "tool") {
      let lastToolMessage: OpenAiMessage | undefined;
      for (const block of message.content) {
        if (block.type === "tool_result") {
          lastToolMessage = { role: "tool", tool_call_id: block.tool_use_id, content: toolResultText(block.content) };
          messages.push(lastToolMessage);
        } else if (block.type === "text" && lastToolMessage) {
          const existing = typeof lastToolMessage.content === "string" ? lastToolMessage.content : "";
          lastToolMessage.content = [existing, block.text].filter(Boolean).join("\n");
        }
      }
      if (!lastToolMessage) throw new Error('messages with role "tool" must contain tool_result blocks');
      continue;
    }
    if (message.role === "system") {
      for (const block of message.content) {
        if (block.type !== "text") throw new Error('messages with role "system" must contain only text blocks');
      }
    }

    let parts: OpenAiContentPart[] = [];
    let toolCalls: OpenAiToolCall[] = [];
    const flush = (): void => {
      if (parts.length === 0 && toolCalls.length === 0) return;
      const first = parts[0];
      const content =
        parts.length === 0
          ? null
          : parts.length === 1 && first?.type === "text"
            ? first.text
            : parts;
      messages.push({
        role: message.role,
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      parts = [];
      toolCalls = [];
    };

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          parts.push({ type: "text", text: block.text });
          break;
        case "image":
          parts.push({
            type: "image_url",
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
              ...(block.detail ?? defaultImageDetail
                ? { detail: block.detail ?? defaultImageDetail }
                : {}),
            },
          });
          break;
        case "tool_use":
          if (message.role !== "assistant") throw new Error("tool_use blocks require the assistant role");
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
          break;
        case "tool_result":
          flush();
          messages.push({ role: "tool", tool_call_id: block.tool_use_id, content: toolResultText(block.content) });
          break;
        case "thinking":
          break;
      }
    }
    flush();
  }
  return messages;
}

function toolResultText(content: string | TextBlock[]): string {
  if (typeof content === "string") return content;
  return content.map((block) => block.text).join("\n");
}

function buildUsageEvent(usage: OpenAiUsage, pricing: TokenPricing | undefined): StreamEvent | undefined {
  if (!usage) return undefined;
  if (usage.prompt_tokens == null && usage.completion_tokens == null) return undefined;
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  return {
    type: "usage",
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.total_tokens ?? undefined,
    cost_usd: usage.cost ?? computeCostUsd(promptTokens, completionTokens, pricing),
    cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0,
  };
}

function parseToolArguments(argumentsText: string): Record<string, unknown> | undefined {
  const trimmed = argumentsText.trim();
  if (trimmed === "") return {};
  const parsed = parseJson(trimmed);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const parsed = z
    .object({ error: z.object({ message: z.string().nullish() }).nullish() })
    .safeParse(parseJson(text));
  if (parsed.success && parsed.data.error?.message) return parsed.data.error.message;
  return text || response.statusText || `HTTP ${response.status}`;
}

function unsupportedParameterNames(message: string): string[] {
  const names = new Set<string>();
  for (const match of message.matchAll(
    /(?:does not support|unsupported)\s+(?:the\s+)?(?:parameters?|params?)\s*:?\s*\[([^\]]*)\]/gi,
  )) {
    for (const name of match[1].matchAll(/["']([a-zA-Z_][a-zA-Z0-9_]*)["']/g)) {
      names.add(name[1]);
    }
  }
  for (const match of message.matchAll(
    /unsupported\s+(?:parameter|parameters|param|params)\s*:?\s*["']?([a-zA-Z_][a-zA-Z0-9_]*)/gi,
  )) {
    names.add(match[1]);
  }
  if (names.size === 0 && /UnsupportedParamsError|does not support/i.test(message)) {
    for (const name of ["reasoning_effort", "reasoning_budget", "chat_template_kwargs", "reasoning"]) {
      const pattern = new RegExp(`["']${name}["']|\\b${name}\\b`, "i");
      if (pattern.test(message)) names.add(name);
    }
  }
  return [...names];
}

function payloadMaxTokensKey(payload: Record<string, unknown>): string | undefined {
  if ("max_completion_tokens" in payload) return "max_completion_tokens";
  if ("max_tokens" in payload) return "max_tokens";
  return undefined;
}

function setPayloadMaxTokens(payload: Record<string, unknown>, value: number): void {
  const key = payloadMaxTokensKey(payload) ?? "max_tokens";
  payload[key] = Math.max(1, Math.round(value));
}

function errorNumber(message: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(message);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function reducedMaxTokens(
  payload: Record<string, unknown>,
  message: string,
): number | undefined {
  const key = payloadMaxTokensKey(payload);
  if (!key) return undefined;
  const current = Number(payload[key]);
  if (!Number.isFinite(current) || current <= 1024) return undefined;

  const requested = errorNumber(message, /requested\s+(\d{3,})\s+output tokens/i);
  const contextLimit = errorNumber(message, /maximum context length is\s+(\d{3,})/i);
  const prompt = errorNumber(message, /prompt contains at least\s+(\d{3,})\s+input tokens/i);
  if (!requested && !contextLimit) return undefined;

  const available =
    contextLimit !== undefined
      ? contextLimit - (prompt ?? 0) - Math.max(2048, Math.floor(contextLimit * 0.02))
      : current;
  const target = Math.min(available, Math.floor((requested ?? current) / 2));
  const next = Math.max(1024, Math.min(current - 1, target));
  return next < current ? next : undefined;
}
