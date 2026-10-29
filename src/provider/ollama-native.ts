import type { ModelCapabilities } from "../config/loader";
import {
  computeCostUsd,
  type ChatRequest,
  type FinishReason,
  type ImageBlock,
  type Message,
  type StreamEvent,
  type TextBlock,
  type TokenPricing,
  type ToolUseBlock,
} from "../types/schema";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_PROVIDER_RETRY_POLICY,
  DEFAULT_REQUEST_TIMEOUT_MS,
  createRequestGuard,
  isRetryableProviderError,
  providerRetryDelayMs,
  sleepAbortable,
  timeoutMessage,
  type RetryPolicy,
} from "./retry";
import type { LLMProvider } from "./router";

export interface OllamaProviderOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  model?: string;
  pricing?: TokenPricing;
  capabilities: ModelCapabilities;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  retryPolicy?: RetryPolicy;
}

const DEFAULT_NUM_CTX = 8192;
const MAX_NUM_CTX = 32_768;

function normalizeOrigin(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function textOf(message: Message): string {
  return message.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toolResultText(content: string | TextBlock[]): string {
  return typeof content === "string" ? content : content.map((block) => block.text).join("\n");
}

/**
 * Ollama's OpenAI-compatible endpoint silently cuts the prompt at the server's
 * default context (often 2048 tokens), which drops the system prompt and the
 * mode rules. The native endpoint accepts options.num_ctx, so it gets the whole
 * conversation.
 */
export function ollamaNumCtx(capabilities: ModelCapabilities): number {
  const override = Number(process.env.ORCHIVOX_OLLAMA_NUM_CTX ?? "");
  if (Number.isFinite(override) && override >= 2048) return Math.round(override);
  const window = capabilities.context_window ?? DEFAULT_NUM_CTX;
  return Math.min(Math.max(Math.round(window), 4096), MAX_NUM_CTX);
}

function imagesOf(message: Message): string[] {
  return message.content
    .filter((block): block is ImageBlock => block.type === "image")
    .map((block) => block.source.data);
}

export function toOllamaMessages(req: ChatRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  const toolNames = new Map<string, string>();
  for (const message of req.messages) {
    if (message.role === "tool") {
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        const toolName = toolNames.get(block.tool_use_id);
        messages.push({
          role: "tool",
          content: toolResultText(block.content),
          ...(toolName ? { tool_name: toolName } : {}),
        });
      }
      continue;
    }
    if (message.role === "system") {
      messages.push({ role: "system", content: textOf(message) });
      continue;
    }
    const toolUses = message.content.filter(
      (block): block is ToolUseBlock => block.type === "tool_use",
    );
    for (const block of toolUses) toolNames.set(block.id, block.name);
    const images = imagesOf(message);
    messages.push({
      role: message.role,
      content: textOf(message),
      ...(toolUses.length > 0
        ? {
            tool_calls: toolUses.map((block) => ({
              function: { name: block.name, arguments: block.input },
            })),
          }
        : {}),
      ...(images.length > 0 ? { images } : {}),
    });
  }
  return messages;
}

export function buildOllamaPayload(
  req: ChatRequest,
  model: string,
  capabilities: ModelCapabilities,
): Record<string, unknown> {
  const effort = req.reasoning_effort?.toLowerCase();
  const thinkingOff = effort === "off" || effort === "none";
  return {
    model,
    messages: toOllamaMessages(req),
    stream: true,
    ...(capabilities.reasoning && effort ? { think: !thinkingOff } : {}),
    ...(req.tools.length > 0
      ? {
          tools: req.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }
      : {}),
    options: {
      num_ctx: ollamaNumCtx(capabilities),
      num_predict: req.max_tokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
      ...(req.stop_sequences.length > 0 ? { stop: req.stop_sequences } : {}),
    },
  };
}

function finishReasonOf(doneReason: unknown): FinishReason {
  return doneReason === "length" ? "length" : "stop";
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to the raw string
    }
    return { value };
  }
  return {};
}

export class OllamaNativeProvider implements LLMProvider {
  private readonly origin: string;
  private readonly apiKey?: string;
  private readonly headers: Record<string, string>;
  private readonly model?: string;
  private readonly pricing?: TokenPricing;
  private readonly capabilities: ModelCapabilities;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly retryPolicy: RetryPolicy;

  constructor(options: OllamaProviderOptions) {
    this.origin = normalizeOrigin(options.baseUrl);
    this.apiKey = options.apiKey;
    this.headers = options.headers ?? {};
    this.model = options.model;
    this.pricing = options.pricing;
    this.capabilities = options.capabilities;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_PROVIDER_RETRY_POLICY;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await fetch(`${this.origin}/api/tags`, {
      headers: this.requestHeaders(),
      signal,
    });
    if (!response.ok) throw new Error(`ollama tags failed: HTTP ${response.status}`);
    const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    return (body.models ?? [])
      .map((entry) => entry.model ?? entry.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
    const model = req.model ?? this.model;
    if (!model) throw new Error("ChatRequest.model is required when the provider has no default model");
    const payload = buildOllamaPayload(req, model, this.capabilities);
    const guard = createRequestGuard(signal, {
      timeoutMs: this.timeoutMs,
      idleTimeoutMs: this.idleTimeoutMs,
    });

    let response: Response | undefined;
    let failureMessage = "";
    let retries = 0;
    try {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          response = await fetch(`${this.origin}/api/chat`, {
            method: "POST",
            headers: this.requestHeaders(),
            body: JSON.stringify(payload),
            signal: guard.signal,
          });
        } catch (error) {
          if (signal?.aborted) {
            yield { type: "done", finish_reason: "aborted" };
            return;
          }
          const timedOut = guard.timedOut();
          const message = timedOut
            ? timeoutMessage(guard.timeoutKind(), this.timeoutMs)
            : error instanceof Error
              ? error.message
              : String(error);
          if (
            this.retryPolicy.enabled &&
            !timedOut &&
            retries < this.retryPolicy.maxRetries &&
            isRetryableProviderError(message)
          ) {
            retries += 1;
            const delayMs = providerRetryDelayMs(this.retryPolicy, retries);
            yield {
              type: "retry_scheduled",
              attempt: retries,
              max_attempts: this.retryPolicy.maxRetries,
              delay_ms: delayMs,
              reason: message.slice(0, 200),
            };
            try {
              await sleepAbortable(delayMs, signal);
            } catch {
              yield { type: "done", finish_reason: "aborted" };
              return;
            }
            continue;
          }
          yield {
            type: "error",
            code: timedOut ? "request_timeout" : "request_failed",
            message,
            recoverable: true,
          };
          yield { type: "done", finish_reason: "error" };
          return;
        }

        if (response.ok) break;
        failureMessage = await this.readErrorBody(response);
        if (
          response.status >= 500 &&
          this.retryPolicy.enabled &&
          retries < this.retryPolicy.maxRetries
        ) {
          retries += 1;
          const delayMs = providerRetryDelayMs(this.retryPolicy, retries);
          yield {
            type: "retry_scheduled",
            attempt: retries,
            max_attempts: this.retryPolicy.maxRetries,
            delay_ms: delayMs,
            reason: failureMessage.slice(0, 200),
          };
          try {
            await sleepAbortable(delayMs, signal);
          } catch {
            yield { type: "done", finish_reason: "aborted" };
            return;
          }
          continue;
        }
        yield {
          type: "error",
          code: `http_${response.status}`,
          message: failureMessage || `HTTP ${response.status}`,
          recoverable: response.status >= 500,
        };
        yield { type: "done", finish_reason: "error" };
        return;
      }

      if (!response?.ok || !response.body) {
        yield { type: "error", code: "request_failed", message: failureMessage || "no response", recoverable: true };
        yield { type: "done", finish_reason: "error" };
        return;
      }

      guard.startIdle();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let callIndex = 0;
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        guard.touch();
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line) continue;
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (typeof chunk.error === "string") {
            yield { type: "error", code: "ollama_error", message: chunk.error, recoverable: false };
            yield { type: "done", finish_reason: "error" };
            return;
          }
          const message = (chunk.message ?? {}) as Record<string, unknown>;
          if (typeof message.thinking === "string" && message.thinking.length > 0) {
            yield { type: "thinking_token", text: message.thinking };
          }
          if (typeof message.content === "string" && message.content.length > 0) {
            yield { type: "token", text: message.content };
          }
          if (Array.isArray(message.tool_calls)) {
            for (const raw of message.tool_calls) {
              const call = (raw ?? {}) as Record<string, unknown>;
              const fn = (call.function ?? {}) as Record<string, unknown>;
              const name = typeof fn.name === "string" ? fn.name : "";
              if (!name) continue;
              callIndex += 1;
              const id =
                typeof call.id === "string" && call.id.length > 0
                  ? call.id
                  : `ollama-call-${Date.now().toString(36)}-${callIndex}`;
              yield {
                type: "tool_call_ready",
                id,
                name,
                arguments: parseArguments(fn.arguments),
              };
            }
          }
          if (chunk.done === true) {
            const promptTokens =
              typeof chunk.prompt_eval_count === "number" ? chunk.prompt_eval_count : 0;
            const completionTokens = typeof chunk.eval_count === "number" ? chunk.eval_count : 0;
            yield {
              type: "usage",
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              cost_usd: computeCostUsd(promptTokens, completionTokens, this.pricing),
            };
            yield { type: "done", finish_reason: finishReasonOf(chunk.done_reason) };
            finished = true;
            return;
          }
        }
      }
      yield { type: "done", finish_reason: "stop" };
    } finally {
      guard.dispose();
    }
  }

  private requestHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...this.headers,
    };
  }

  private async readErrorBody(response: Response): Promise<string> {
    const text = await response.text().catch(() => "");
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") return parsed.error;
    } catch {
      // plain text error
    }
    return text || response.statusText || `HTTP ${response.status}`;
  }
}
