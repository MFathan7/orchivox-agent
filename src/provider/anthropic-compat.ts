import { z } from "zod";

import type { ModelCapabilities } from "../config/loader";
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

export interface AnthropicCompatProviderOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  model?: string;
  pricing?: TokenPricing;
  capabilities: ModelCapabilities;
}

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETA = "prompt-caching-2024-07-31";

type CacheControl = { type: "ephemeral" };

type AnthropicTextBlock = { type: "text"; text: string; cache_control?: CacheControl };
type AnthropicImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
type AnthropicThinkingBlock = { type: "thinking"; thinking: string; signature?: string };
type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: CacheControl;
};
type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
  is_error: boolean;
  cache_control?: CacheControl;
};
type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;
type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicBlock[] };

const AnthropicUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().nullish(),
  output_tokens: z.number().int().nonnegative().nullish(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
  cache_read_input_tokens: z.number().int().nonnegative().nullish(),
});

const AnthropicMessageStartSchema = z.object({
  message: z.object({ usage: AnthropicUsageSchema.nullish() }),
});

const AnthropicContentBlockStartSchema = z.object({
  index: z.number().int().nonnegative(),
  content_block: z.object({
    type: z.string(),
    id: z.string().nullish(),
    name: z.string().nullish(),
    text: z.string().nullish(),
    thinking: z.string().nullish(),
  }),
});

const AnthropicContentBlockDeltaSchema = z.object({
  index: z.number().int().nonnegative(),
  delta: z.object({
    type: z.string(),
    text: z.string().nullish(),
    thinking: z.string().nullish(),
    signature: z.string().nullish(),
    partial_json: z.string().nullish(),
  }),
});

const AnthropicContentBlockStopSchema = z.object({
  index: z.number().int().nonnegative(),
});

const AnthropicMessageDeltaSchema = z.object({
  delta: z.object({ stop_reason: z.string().nullish() }).nullish(),
  usage: z.object({ output_tokens: z.number().int().nonnegative().nullish() }).nullish(),
});

const AnthropicErrorEventSchema = z.object({
  error: z
    .object({
      type: z.string().nullish(),
      message: z.string().nullish(),
    })
    .nullish(),
});

const AnthropicModelsSchema = z.object({
  data: z.array(z.object({ id: z.string() })).default([]),
});

const STOP_REASONS: Record<string, FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "refusal",
};

export class AnthropicCompatProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly extraHeaders: Record<string, string>;
  private readonly model: string | undefined;
  private readonly pricing: TokenPricing | undefined;
  private readonly capabilities: ModelCapabilities;

  constructor(options: AnthropicCompatProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.extraHeaders = options.headers ?? {};
    this.model = options.model;
    this.pricing = options.pricing;
    this.capabilities = options.capabilities;
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
    const model = req.model ?? this.model;
    if (!model) throw new Error("ChatRequest.model is required when the provider has no default model");

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: this.requestHeaders(),
        body: JSON.stringify(buildMessagesPayload(req, model, this.capabilities)),
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
      const message = await readErrorBody(response);
      learnLimitsFromError(this.baseUrl, model, message);
      yield {
        type: "error",
        code: `http_${response.status}`,
        message,
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

    const blocks = new Map<number, { type: string; id: string; name: string; argumentsText: string }>();
    let promptTokens = 0;
    let completionTokens = 0;
    let cacheRead = 0;
    let cacheCreation = 0;
    let usageSeen = false;
    let stopReason: string | undefined;

    try {
      stream: for await (const message of iterateSse(response.body, signal)) {
        const json = parseJson(message.data);
        switch (message.event) {
          case "message_start": {
            const parsed = AnthropicMessageStartSchema.safeParse(json);
            if (!parsed.success) {
              yield invalidEventError(message.event);
              break;
            }
            const usage = parsed.data.message.usage;
            if (usage) {
              usageSeen = true;
              promptTokens = usage.input_tokens ?? 0;
              cacheRead = usage.cache_read_input_tokens ?? 0;
              cacheCreation = usage.cache_creation_input_tokens ?? 0;
            }
            break;
          }
          case "content_block_start": {
            const parsed = AnthropicContentBlockStartSchema.safeParse(json);
            if (!parsed.success) {
              yield invalidEventError(message.event);
              break;
            }
            const { index, content_block: block } = parsed.data;
            if (block.type === "tool_use") {
              const id = block.id ?? `tool_${index}`;
              blocks.set(index, { type: block.type, id, name: block.name ?? "", argumentsText: "" });
              yield {
                type: "tool_call_delta",
                id,
                index,
                name_delta: block.name ?? "",
                arguments_delta: "",
              };
            } else {
              blocks.set(index, { type: block.type, id: "", name: "", argumentsText: "" });
              if (block.type === "text" && block.text) yield { type: "token", text: block.text };
              if (block.type === "thinking" && block.thinking) {
                yield { type: "thinking_token", text: block.thinking };
              }
            }
            break;
          }
          case "content_block_delta": {
            const parsed = AnthropicContentBlockDeltaSchema.safeParse(json);
            if (!parsed.success) {
              yield invalidEventError(message.event);
              break;
            }
            const { index, delta } = parsed.data;
            const state = blocks.get(index);
            if (delta.type === "text_delta" && delta.text) {
              yield { type: "token", text: delta.text };
            } else if (delta.type === "thinking_delta" && delta.thinking) {
              yield { type: "thinking_token", text: delta.thinking };
            } else if (delta.type === "signature_delta" && delta.signature) {
              yield { type: "thinking_token", text: "", signature: delta.signature };
            } else if (delta.type === "input_json_delta") {
              const fragment = delta.partial_json ?? "";
              if (state) state.argumentsText += fragment;
              yield {
                type: "tool_call_delta",
                id: state?.id ?? `tool_${index}`,
                index,
                name_delta: "",
                arguments_delta: fragment,
              };
            }
            break;
          }
          case "content_block_stop": {
            const parsed = AnthropicContentBlockStopSchema.safeParse(json);
            if (!parsed.success) {
              yield invalidEventError(message.event);
              break;
            }
            const state = blocks.get(parsed.data.index);
            blocks.delete(parsed.data.index);
            if (state?.type === "tool_use") {
              const toolArguments = parseToolArguments(state.argumentsText);
              if (!toolArguments) {
                yield {
                  type: "error",
                  code: "tool_arguments_parse_error",
                  message: `tool call "${state.name}" sent invalid JSON arguments`,
                  recoverable: true,
                };
              } else {
                yield { type: "tool_call_ready", id: state.id, name: state.name, arguments: toolArguments };
              }
            }
            break;
          }
          case "message_delta": {
            const parsed = AnthropicMessageDeltaSchema.safeParse(json);
            if (!parsed.success) {
              yield invalidEventError(message.event);
              break;
            }
            const reason = parsed.data.delta?.stop_reason;
            if (reason) stopReason = reason;
            const output = parsed.data.usage?.output_tokens;
            if (output != null) {
              completionTokens = output;
              usageSeen = true;
            }
            break;
          }
          case "message_stop":
            break stream;
          case "error": {
            const parsed = AnthropicErrorEventSchema.safeParse(json);
            yield {
              type: "error",
              code: parsed.success ? (parsed.data.error?.type ?? "provider_error") : "provider_error",
              message: (parsed.success ? (parsed.data.error?.message ?? undefined) : undefined) ?? message.data,
              recoverable: false,
            };
            yield { type: "done", finish_reason: "error" };
            return;
          }
          default:
            break;
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

    if (usageSeen) {
      yield {
        type: "usage",
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        cost_usd: computeCostUsd(promptTokens, completionTokens, this.pricing),
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      };
    }
    yield { type: "done", finish_reason: stopReason ? (STOP_REASONS[stopReason] ?? "stop") : "stop" };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/v1/models`, { headers: this.requestHeaders(), signal });
    if (!response.ok) {
      throw new Error(`models request failed with status ${response.status}: ${await readErrorBody(response)}`);
    }
    const parsed = AnthropicModelsSchema.safeParse(parseJson(await response.text()));
    if (!parsed.success) throw new Error("models response did not match the expected shape");
    return parsed.data.data.map((model) => model.id);
  }

  private requestHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_BETA,
      ...this.extraHeaders,
    };
  }
}

export function buildMessagesPayload(
  req: ChatRequest,
  model: string,
  capabilities: ModelCapabilities,
): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(req);
  const payload: Record<string, unknown> = {
    model,
    max_tokens: req.max_tokens,
    messages,
    stream: true,
  };
  if (system.length > 0) payload.system = system;
  if (req.temperature !== undefined) payload.temperature = req.temperature;
  if (req.top_p !== undefined) payload.top_p = req.top_p;
  if (req.stop_sequences.length > 0) payload.stop_sequences = req.stop_sequences;
  if (req.tools.length > 0) {
    payload.tools = req.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: toolParametersToJsonSchema(tool.parameters),
    }));
    payload.tool_choice = {
      type: req.tool_choice === "required" ? "any" : req.tool_choice === "none" ? "none" : "auto",
    };
  }
  if (req.reasoning_effort && capabilities.reasoning) {
    const minBudget = capabilities.reasoning_budget_min ?? 1024;
    const maxBudget = capabilities.reasoning_budget_max ?? 8192;
    const effort = req.reasoning_effort.toLowerCase();
    const requested =
      effort === "high" || effort === "max" || effort === "xhigh"
        ? maxBudget
        : effort === "medium"
          ? Math.min(4096, maxBudget)
          : Math.min(1024, maxBudget);
    const headroom = Math.max(minBudget, req.max_tokens - 1024);
    const budget = Math.max(minBudget, Math.min(requested, maxBudget, headroom));
    payload.thinking = { type: "enabled", budget_tokens: budget };
    payload.max_tokens = Math.max(req.max_tokens, budget + 1024);
    payload.temperature = 1;
  }
  return payload;
}

export function toAnthropicMessages(req: ChatRequest): { system: AnthropicTextBlock[]; messages: AnthropicMessage[] } {
  const systemTexts: string[] = [];
  if (req.system) systemTexts.push(req.system);
  const messages: AnthropicMessage[] = [];

  for (const message of req.messages) {
    if (message.role === "system") {
      for (const block of message.content) {
        if (block.type !== "text") throw new Error('messages with role "system" must contain only text blocks');
        systemTexts.push(block.text);
      }
      continue;
    }

    const blocks: AnthropicBlock[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          blocks.push({ type: "text", text: block.text });
          break;
        case "image":
          blocks.push({ type: "image", source: block.source });
          break;
        case "thinking":
          blocks.push({
            type: "thinking",
            thinking: block.thinking,
            ...(block.signature ? { signature: block.signature } : {}),
          });
          break;
        case "tool_use":
          if (message.role !== "assistant") throw new Error("tool_use blocks require the assistant role");
          blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
          break;
        case "tool_result":
          if (message.role !== "user" && message.role !== "tool") {
            throw new Error("tool_result blocks require the user or tool role");
          }
          blocks.push({
            type: "tool_result",
            tool_use_id: block.tool_use_id,
            content: toolResultContent(block.content),
            is_error: block.is_error,
          });
          break;
      }
    }
    if (blocks.length === 0) continue;

    const role = message.role === "assistant" ? "assistant" : "user";
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }

  const system: AnthropicTextBlock[] = systemTexts.map((text) => ({ type: "text", text }));
  if (system.length > 0) system[system.length - 1].cache_control = { type: "ephemeral" };

  const lastMessage = messages[messages.length - 1];
  if (lastMessage) {
    for (let i = lastMessage.content.length - 1; i >= 0; i -= 1) {
      const block = lastMessage.content[i];
      if (block.type === "text" || block.type === "tool_use" || block.type === "tool_result") {
        block.cache_control = { type: "ephemeral" };
        break;
      }
    }
  }
  return { system, messages };
}

function toolResultContent(content: string | TextBlock[]): string | AnthropicTextBlock[] {
  if (typeof content === "string") return content;
  return content.map((block) => ({ type: "text", text: block.text }));
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

function invalidEventError(event: string | undefined): StreamEvent {
  return {
    type: "error",
    code: "invalid_event",
    message: `provider sent an unparsable "${event ?? "unknown"}" event`,
    recoverable: true,
  };
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
