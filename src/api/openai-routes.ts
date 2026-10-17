import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { ContentBlock, Message, StreamEvent, ToolDefinition, Usage } from "../types/schema";
import {
  AGENT_PROFILES,
  AgentProfileSchema,
  AgentRunRequestSchema,
  type AgentRunRequest,
  type AgentRunResult,
  type IAgentRunner,
  type ToolChoice,
} from "./server";

const MODELS_CREATED_AT = Math.floor(Date.now() / 1000);

const ModelListSchema = z.object({
  object: z.literal("list"),
  data: z.array(
    z.object({
      id: z.string(),
      object: z.literal("model"),
      created: z.number().int(),
      owned_by: z.string(),
    }),
  ),
});

const OpenAiToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function").optional(),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
});

const OpenAiMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z
    .union([z.string(), z.array(z.object({ type: z.literal("text"), text: z.string() })), z.null()])
    .optional(),
  tool_calls: z.array(OpenAiToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  reasoning_content: z.string().optional(),
});

const OpenAiToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(OpenAiMessageSchema).min(1),
  stream: z.boolean().default(false),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(OpenAiToolSchema).optional(),
  tool_choice: z
    .union([
      z.enum(["auto", "none", "required"]),
      z.object({ type: z.literal("function"), function: z.object({ name: z.string().min(1) }) }),
    ])
    .optional(),
});

const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number().int(),
      message: z.object({
        role: z.literal("assistant"),
        content: z.string().nullable(),
        reasoning_content: z.string().optional(),
        tool_calls: z.array(OpenAiToolCallSchema).optional(),
      }),
      finish_reason: z.string(),
    }),
  ),
  usage: z.object({
    prompt_tokens: z.number().int(),
    completion_tokens: z.number().int(),
    total_tokens: z.number().int(),
  }),
});

const ErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.string().optional(),
  }),
});

const modelsRoute = createRoute({
  method: "get",
  path: "/v1/models",
  summary: "List the agent model profiles",
  tags: ["openai"],
  responses: {
    200: {
      description: "OpenAI-style model list",
      content: { "application/json": { schema: ModelListSchema } },
    },
    401: { description: "Missing or invalid api key", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const chatCompletionsRoute = createRoute({
  method: "post",
  path: "/v1/chat/completions",
  summary: "Run the agent with the OpenAI chat completions wire format",
  tags: ["openai"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ChatCompletionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "A completed chat response, or an SSE stream of chat completion chunks when stream is true",
      content: {
        "application/json": { schema: ChatCompletionResponseSchema },
        "text/event-stream": { schema: z.string() },
      },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Missing or invalid api key", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Runner failure", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerOpenAIRoutes(app: OpenAPIHono, runner: IAgentRunner): void {
  app.openapi(modelsRoute, (c) =>
    c.json(
      {
        object: "list" as const,
        data: AGENT_PROFILES.map((id) => ({
          id,
          object: "model" as const,
          created: MODELS_CREATED_AT,
          owned_by: "orchivox",
        })),
      },
      200,
    ),
  );

  app.openapi(chatCompletionsRoute, async (c) => {
    const body = c.req.valid("json");
    const translated = toAgentRunRequest(body);
    if (!translated.ok) {
      return c.json({ error: { message: translated.message, type: "invalid_request_error" } }, 400);
    }

    const completionId = `chatcmpl-${crypto.randomUUID()}`;
    if (!body.stream) {
      const result = await runner.runOnce(translated.request);
      return c.json(toChatCompletion(body.model, completionId, result), 200);
    }

    const abort = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start: async (streamController) => {
        await writeChatCompletionStream(
          runner,
          translated.request,
          body.model,
          completionId,
          streamController,
          abort.signal,
        );
        streamController.close();
      },
      cancel: () => {
        abort.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });
}

type OpenAiMessage = z.infer<typeof OpenAiMessageSchema>;
type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

function toAgentRunRequest(
  body: ChatCompletionRequest,
): { ok: true; request: AgentRunRequest } | { ok: false; message: string } {
  const profile = AgentProfileSchema.safeParse(body.model);
  if (!profile.success) {
    return {
      ok: false,
      message: `unknown model "${body.model}", expected one of: ${AGENT_PROFILES.join(", ")}`,
    };
  }

  const messages: Message[] = [];
  for (const [index, message] of body.messages.entries()) {
    const translated = toAgentMessage(message, index);
    if ("error" in translated) return { ok: false, message: translated.error };
    messages.push(translated.message);
  }

  return {
    ok: true,
    request: AgentRunRequestSchema.parse({
      profile: profile.data,
      messages,
      tools: (body.tools ?? []).map(toToolDefinition),
      tool_choice: toToolChoice(body.tool_choice),
      max_tokens: body.max_tokens ?? body.max_completion_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stop_sequences: body.stop === undefined ? [] : Array.isArray(body.stop) ? body.stop : [body.stop],
    }),
  };
}

function toAgentMessage(
  message: OpenAiMessage,
  index: number,
): { ok: true; message: Message } | { error: string } {
  const blocks: ContentBlock[] = [];
  if (message.reasoning_content) blocks.push({ type: "thinking", thinking: message.reasoning_content });
  const text = contentToText(message.content);

  if (message.role === "tool") {
    if (!message.tool_call_id) {
      return { error: `messages[${index}].tool_call_id is required when role is "tool"` };
    }
    blocks.push({ type: "tool_result", tool_use_id: message.tool_call_id, content: text, is_error: false });
    return { ok: true, message: { id: `openai-${index}`, role: "tool", content: blocks } };
  }

  if (text) blocks.push({ type: "text", text });
  for (const call of message.tool_calls ?? []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.function.arguments || "{}");
    } catch {
      return { error: `messages[${index}].tool_calls arguments must be valid JSON` };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: `messages[${index}].tool_calls arguments must be a JSON object` };
    }
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: parsed as Record<string, unknown>,
    });
  }
  return { ok: true, message: { id: `openai-${index}`, role: message.role, content: blocks } };
}

function contentToText(content: OpenAiMessage["content"]): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  return content.map((part) => part.text).join("\n");
}

function toToolDefinition(tool: z.infer<typeof OpenAiToolSchema>): ToolDefinition {
  return {
    name: tool.function.name,
    description: tool.function.description ?? tool.function.name,
    parameters: tool.function.parameters ?? { type: "object", properties: {} },
    strict: tool.function.strict ?? false,
    metadata: {},
  };
}

function toToolChoice(value: ChatCompletionRequest["tool_choice"]): ToolChoice {
  if (value === undefined) return { mode: "auto" };
  if (typeof value === "string") return { mode: value };
  return { mode: "required", name: value.function.name };
}

function toChatCompletion(
  model: string,
  id: string,
  result: AgentRunResult,
): z.infer<typeof ChatCompletionResponseSchema> {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: toOpenAiAssistantMessage(result.message),
        finish_reason: toOpenAiFinishReason(result.finish_reason),
      },
    ],
    usage: toOpenAiUsage(result.usage),
  };
}

function toOpenAiAssistantMessage(
  message: Message,
): z.infer<typeof ChatCompletionResponseSchema>["choices"][number]["message"] {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: z.infer<typeof OpenAiToolCallSchema>[] = [];
  for (const block of message.content) {
    if (block.type === "text") textParts.push(block.text);
    else if (block.type === "thinking") reasoningParts.push(block.thinking);
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    }
  }
  return {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("\n") : null,
    ...(reasoningParts.length > 0 ? { reasoning_content: reasoningParts.join("\n") } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function toOpenAiFinishReason(reason: AgentRunResult["finish_reason"]): string {
  switch (reason) {
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

function toOpenAiUsage(usage: Usage | undefined): z.infer<typeof ChatCompletionResponseSchema>["usage"] {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage?.total_tokens ?? promptTokens + completionTokens,
  };
}

async function writeChatCompletionStream(
  runner: IAgentRunner,
  request: AgentRunRequest,
  model: string,
  id: string,
  out: { enqueue(chunk: Uint8Array): void },
  signal: AbortSignal,
): Promise<void> {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  const write = (payload: unknown): void => {
    out.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  const toolIndexes = new Map<string, number>();
  let usage: Usage | undefined;
  let finishReason: AgentRunResult["finish_reason"] = "stop";
  let sawToolCall = false;

  for await (const event of runner.runStream(request, signal)) {
    switch (event.type) {
      case "token":
        write(chunk({ content: event.text }));
        break;
      case "thinking_token":
        write(chunk({ reasoning_content: event.text }));
        break;
      case "rule_violation":
        write(chunk({ reasoning_content: `[rule_violation] ${event.message}` }));
        break;
      case "tool_call_delta": {
        sawToolCall = true;
        if (!toolIndexes.has(event.id)) toolIndexes.set(event.id, toolIndexes.size);
        const fn: Record<string, unknown> = {};
        if (event.name_delta) fn.name = event.name_delta;
        if (event.arguments_delta) fn.arguments = event.arguments_delta;
        write(
          chunk({
            tool_calls: [{ index: toolIndexes.get(event.id), id: event.id, type: "function", function: fn }],
          }),
        );
        break;
      }
      case "tool_call_ready": {
        sawToolCall = true;
        if (!toolIndexes.has(event.id)) {
          toolIndexes.set(event.id, toolIndexes.size);
          write(
            chunk({
              tool_calls: [
                {
                  index: toolIndexes.get(event.id),
                  id: event.id,
                  type: "function",
                  function: { name: event.name, arguments: JSON.stringify(event.arguments) },
                },
              ],
            }),
          );
        }
        break;
      }
      case "usage":
        usage = event;
        break;
      case "error":
        write({ error: { message: event.message, type: "server_error", code: event.code } });
        break;
      case "done":
        finishReason = event.finish_reason;
        break;
    }
  }

  const effectiveReason = sawToolCall && finishReason === "stop" ? "tool_calls" : finishReason;
  write({ ...chunk({}, toOpenAiFinishReason(effectiveReason)), usage: toOpenAiUsage(usage) });
  out.enqueue(encoder.encode("data: [DONE]\n\n"));
}
