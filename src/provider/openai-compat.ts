import { z } from "zod";

import {
  computeCostUsd,
  toolParametersToJsonSchema,
  type ChatRequest,
  type FinishReason,
  type StreamEvent,
  type TextBlock,
  type TokenPricing,
} from "../types/schema";
import type { LLMProvider } from "./router";
import { iterateSse } from "./sse";

export interface OpenAICompatProviderOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  model?: string;
  pricing?: TokenPricing;
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
type OpenAiMessage = {
  role: string;
  content?: string | null;
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

export class OpenAICompatProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly extraHeaders: Record<string, string>;
  private readonly model: string | undefined;
  private readonly pricing: TokenPricing | undefined;

  constructor(options: OpenAICompatProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.extraHeaders = options.headers ?? {};
    this.model = options.model;
    this.pricing = options.pricing;
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
    const model = req.model ?? this.model;
    if (!model) throw new Error("ChatRequest.model is required when the provider has no default model");

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.requestHeaders(),
        body: JSON.stringify(buildChatPayload(req, model)),
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

    if (!response.ok) {
      yield {
        type: "error",
        code: `http_${response.status}`,
        message: await readErrorBody(response),
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
            if (delta.content) yield { type: "token", text: delta.content };
            const reasoning = delta.reasoning_content ?? delta.reasoning;
            if (reasoning) yield { type: "thinking_token", text: reasoning };
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

function buildChatPayload(req: ChatRequest, model: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(req),
    max_tokens: req.max_tokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.temperature !== undefined) payload.temperature = req.temperature;
  if (req.top_p !== undefined) payload.top_p = req.top_p;
  if (req.stop_sequences.length > 0) payload.stop = req.stop_sequences;
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
  }
  return payload;
}

function toOpenAiMessages(req: ChatRequest): OpenAiMessage[] {
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
          lastToolMessage.content = [lastToolMessage.content ?? "", block.text].filter(Boolean).join("\n");
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

    let text: string[] = [];
    let toolCalls: OpenAiToolCall[] = [];
    const flush = (): void => {
      if (text.length === 0 && toolCalls.length === 0) return;
      messages.push({
        role: message.role,
        content: text.length > 0 ? text.join("\n") : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      text = [];
      toolCalls = [];
    };

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          text.push(block.text);
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
