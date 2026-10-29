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

const AnthropicCacheControlSchema = z.object({ type: z.literal("ephemeral") });

const AnthropicTextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  cache_control: AnthropicCacheControlSchema.optional(),
});

const AnthropicThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});

const AnthropicToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  cache_control: AnthropicCacheControlSchema.optional(),
});

const AnthropicToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(AnthropicTextBlockSchema)]),
  is_error: z.boolean().optional(),
  cache_control: AnthropicCacheControlSchema.optional(),
});

const AnthropicImageBlockSchema = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.string().min(1),
    data: z.string().min(1),
  }),
});

const AnthropicContentBlockSchema = z.discriminatedUnion("type", [
  AnthropicTextBlockSchema,
  AnthropicImageBlockSchema,
  AnthropicThinkingBlockSchema,
  AnthropicToolUseBlockSchema,
  AnthropicToolResultBlockSchema,
]);

const MessagesRequestSchema = z.object({
  model: z.string().min(1),
  system: z.union([z.string(), z.array(AnthropicTextBlockSchema)]).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.union([z.string(), z.array(AnthropicContentBlockSchema)]),
      }),
    )
    .min(1),
  tools: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        input_schema: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  tool_choice: z
    .object({ type: z.enum(["auto", "any", "none", "tool"]), name: z.string().optional() })
    .optional(),
  max_tokens: z.number().int().positive(),
  stream: z.boolean().default(false),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop_sequences: z.array(z.string()).optional(),
  metadata: z.object({ user_id: z.string().optional() }).optional(),
});

const AnthropicOutputBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string().optional() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
]);

const MessagesResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: z.string(),
  content: z.array(AnthropicOutputBlockSchema),
  stop_reason: z.string().nullable(),
  stop_sequence: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    cache_creation_input_tokens: z.number().int(),
    cache_read_input_tokens: z.number().int(),
  }),
});

const ErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.string().optional(),
  }),
});

const messagesRoute = createRoute({
  method: "post",
  path: "/v1/messages",
  summary: "Run the agent with the Anthropic messages wire format",
  tags: ["anthropic"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: MessagesRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "A completed message, or an Anthropic SSE stream when stream is true",
      content: {
        "application/json": { schema: MessagesResponseSchema },
        "text/event-stream": { schema: z.string() },
      },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Missing or invalid api key", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Runner failure", content: { "application/json": { schema: ErrorSchema } } },
  },
});

type MessagesRequest = z.infer<typeof MessagesRequestSchema>;
type AnthropicContentBlock = z.infer<typeof AnthropicContentBlockSchema>;

export function registerAnthropicRoutes(app: OpenAPIHono, runner: IAgentRunner): void {
  app.openapi(messagesRoute, async (c) => {
    const body = c.req.valid("json");
    const translated = toAgentRunRequest(body);
    if (!translated.ok) {
      return c.json({ error: { message: translated.message, type: "invalid_request_error" } }, 400);
    }

    const messageId = `msg_${crypto.randomUUID()}`;
    if (!body.stream) {
      const result = await runner.runOnce(translated.request);
      return c.json(toAnthropicMessage(body.model, messageId, result), 200);
    }

    const abort = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start: async (streamController) => {
        await writeMessagesStream(
          runner,
          translated.request,
          body.model,
          messageId,
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

function toAgentRunRequest(
  body: MessagesRequest,
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
      system: systemToText(body.system),
      messages,
      tools: (body.tools ?? []).map((tool) => toToolDefinition(tool)),
      tool_choice: toToolChoice(body.tool_choice),
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      top_p: body.top_p,
      stop_sequences: body.stop_sequences ?? [],
    }),
  };
}

function systemToText(system: MessagesRequest["system"]): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n");
}

function toAgentMessage(
  message: MessagesRequest["messages"][number],
  index: number,
): { ok: true; message: Message } | { error: string } {
  const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    const translated = toAgentBlock(block, index);
    if ("error" in translated) return translated;
    blocks.push(translated.block);
  }
  return { ok: true, message: { id: `anthropic-${index}`, role: message.role, content: blocks } };
}

function toAgentBlock(
  block: AnthropicContentBlock,
  index: number,
): { ok: true; block: ContentBlock } | { error: string } {
  switch (block.type) {
    case "text":
      return { ok: true, block: { type: "text", text: block.text } };
    case "image":
      return { ok: true, block: { type: "image", source: block.source } };
    case "thinking":
      return {
        ok: true,
        block: { type: "thinking", thinking: block.thinking, ...(block.signature ? { signature: block.signature } : {}) },
      };
    case "tool_use":
      return { ok: true, block: { type: "tool_use", id: block.id, name: block.name, input: block.input } };
    case "tool_result": {
      const text =
        typeof block.content === "string"
          ? block.content
          : block.content.map((part) => part.text).join("\n");
      return {
        ok: true,
        block: {
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: text,
          is_error: block.is_error ?? false,
        },
      };
    }
    default:
      return { error: `messages[${index}] contains an unsupported content block` };
  }
}

function toToolDefinition(tool: NonNullable<MessagesRequest["tools"]>[number]): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? tool.name,
    parameters: tool.input_schema,
    strict: false,
    metadata: {},
  };
}

function toToolChoice(value: MessagesRequest["tool_choice"]): ToolChoice {
  if (!value) return { mode: "auto" };
  switch (value.type) {
    case "auto":
      return { mode: "auto" };
    case "none":
      return { mode: "none" };
    case "any":
      return { mode: "required" };
    case "tool":
      return { mode: "required", name: value.name };
  }
}

function toAnthropicMessage(
  model: string,
  id: string,
  result: AgentRunResult,
): z.infer<typeof MessagesResponseSchema> {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: toAnthropicOutputBlocks(result.message),
    stop_reason: toAnthropicStopReason(result.finish_reason),
    stop_sequence: null,
    usage: toAnthropicUsage(result.usage),
  };
}

function toAnthropicOutputBlocks(message: Message): z.infer<typeof AnthropicOutputBlockSchema>[] {
  const blocks: z.infer<typeof AnthropicOutputBlockSchema>[] = [];
  for (const block of message.content) {
    if (block.type === "text") blocks.push({ type: "text", text: block.text });
    else if (block.type === "thinking") {
      blocks.push({
        type: "thinking",
        thinking: block.thinking,
        ...(block.signature ? { signature: block.signature } : {}),
      });
    } else if (block.type === "tool_use") {
      blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    }
  }
  return blocks;
}

function toAnthropicStopReason(reason: AgentRunResult["finish_reason"]): string | null {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
    case "turn_limit":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
    case "refusal":
      return "refusal";
    default:
      return null;
  }
}

function toAnthropicUsage(usage: Usage | undefined): z.infer<typeof MessagesResponseSchema>["usage"] {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
  };
}

async function writeMessagesStream(
  runner: IAgentRunner,
  request: AgentRunRequest,
  model: string,
  messageId: string,
  out: { enqueue(chunk: Uint8Array): void },
  signal: AbortSignal,
): Promise<void> {
  const encoder = new TextEncoder();
  const write = (event: string, payload: unknown): void => {
    out.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
  };

  write("message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });

  let openBlock: { index: number; type: "text" | "thinking" | "tool_use"; id?: string; name: string } | undefined;
  let nextIndex = 0;
  let usage: Usage | undefined;
  let finishReason: AgentRunResult["finish_reason"] = "stop";
  let errored = false;

  const closeBlock = (): void => {
    if (!openBlock) return;
    write("content_block_stop", { type: "content_block_stop", index: openBlock.index });
    openBlock = undefined;
  };
  const openTextBlock = (): number => {
    if (openBlock?.type !== "text") {
      closeBlock();
      openBlock = { index: nextIndex++, type: "text", name: "" };
      write("content_block_start", {
        type: "content_block_start",
        index: openBlock.index,
        content_block: { type: "text", text: "" },
      });
    }
    return openBlock.index;
  };
  const openThinkingBlock = (): number => {
    if (openBlock?.type !== "thinking") {
      closeBlock();
      openBlock = { index: nextIndex++, type: "thinking", name: "" };
      write("content_block_start", {
        type: "content_block_start",
        index: openBlock.index,
        content_block: { type: "thinking", thinking: "" },
      });
    }
    return openBlock.index;
  };
  const openToolBlock = (id: string, name: string): number => {
    if (openBlock?.type !== "tool_use" || openBlock.id !== id) {
      closeBlock();
      openBlock = { index: nextIndex++, type: "tool_use", id, name };
      write("content_block_start", {
        type: "content_block_start",
        index: openBlock.index,
        content_block: { type: "tool_use", id, name, input: {} },
      });
    }
    return openBlock.index;
  };

  const pendingToolNames = new Map<string, string>();

  for await (const event of runner.runStream(request, signal)) {
    switch (event.type) {
      case "token":
        write("content_block_delta", {
          type: "content_block_delta",
          index: openTextBlock(),
          delta: { type: "text_delta", text: event.text },
        });
        break;
      case "thinking_token":
        write("content_block_delta", {
          type: "content_block_delta",
          index: openThinkingBlock(),
          delta: { type: "thinking_delta", thinking: event.text },
        });
        break;
      case "rule_violation":
        write("content_block_delta", {
          type: "content_block_delta",
          index: openThinkingBlock(),
          delta: { type: "thinking_delta", thinking: `[rule_violation] ${event.message}` },
        });
        break;
      case "tool_call_delta": {
        const name = (pendingToolNames.get(event.id) ?? "") + event.name_delta;
        pendingToolNames.set(event.id, name);
        const index = openToolBlock(event.id, name);
        if (event.arguments_delta) {
          write("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: event.arguments_delta },
          });
        }
        break;
      }
      case "tool_call_ready": {
        if (openBlock?.type === "tool_use" && openBlock.id === event.id) {
          closeBlock();
        } else {
          const index = openToolBlock(event.id, event.name);
          write("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(event.arguments) },
          });
          closeBlock();
        }
        break;
      }
      case "usage":
        usage = event;
        break;
      case "error":
        errored = true;
        write("error", {
          type: "error",
          error: { type: event.recoverable ? "invalid_request_error" : "api_error", message: event.message },
        });
        break;
      case "done":
        finishReason = event.finish_reason;
        break;
    }
  }

  closeBlock();
  if (errored) return;
  write("message_delta", {
    type: "message_delta",
    delta: { stop_reason: toAnthropicStopReason(finishReason), stop_sequence: null },
    usage: toAnthropicUsage(usage),
  });
  write("message_stop", { type: "message_stop" });
}
