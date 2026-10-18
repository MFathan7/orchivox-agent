import { describe, expect, it } from "bun:test";

import type { ModelCapabilities } from "../src/config/loader";
import { buildMessagesPayload } from "../src/provider/anthropic-compat";
import { buildChatPayload, toOpenAiMessages } from "../src/provider/openai-compat";
import { ChatRequestSchema } from "../src/types/schema";

function caps(partial: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    tool_calling: true,
    reasoning: false,
    vision: false,
    context_window: 128_000,
    max_output: 8192,
    structured_output: false,
    temperature: true,
    pdf: false,
    parallel_tool_calls: true,
    ...partial,
  };
}

const request = ChatRequestSchema.parse({
  messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }] }],
  max_tokens: 4096,
  temperature: 0.5,
  reasoning_effort: "high",
  tools: [
    {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: {} },
    },
  ],
  response_format: { type: "json_object" },
});

describe("provider payload wiring", () => {
  it("uses max_completion_tokens and skips temperature for OpenAI reasoning models", () => {
    const payload = buildChatPayload(
      request,
      "o3-mini",
      "openai",
      caps({ reasoning: true, temperature: false, structured_output: true }),
    );

    expect(payload.max_completion_tokens).toBe(4096);
    expect(payload.max_tokens).toBeUndefined();
    expect(payload.temperature).toBeUndefined();
    expect(payload.top_p).toBeUndefined();
    expect(payload.reasoning_effort).toBe("high");
    expect(payload.parallel_tool_calls).toBe(true);
    expect(payload.response_format).toEqual({ type: "json_object" });
  });

  it("uses the OpenRouter reasoning object and keeps max_tokens", () => {
    const payload = buildChatPayload(
      request,
      "openai/gpt-5.4",
      "openrouter",
      caps({ reasoning: true, temperature: true, structured_output: true }),
    );

    expect(payload.max_tokens).toBe(4096);
    expect(payload.max_completion_tokens).toBeUndefined();
    expect(payload.reasoning).toEqual({ effort: "high" });
    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.temperature).toBeUndefined();
  });

  it("keeps temperature and omits reasoning fields for normal models", () => {
    const payload = buildChatPayload(
      request,
      "gpt-4.1",
      "openai",
      caps({ reasoning: false, temperature: true, structured_output: false }),
    );

    expect(payload.max_tokens).toBe(4096);
    expect(payload.temperature).toBe(0.5);
    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.response_format).toBeUndefined();
  });

  it("maps Anthropic thinking budget and temperature", () => {
    const payload = buildMessagesPayload(
      request,
      "claude-opus-4-5",
      caps({ reasoning: true, reasoning_budget_min: 1024, reasoning_budget_max: 8192 }),
    );

    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 3072 });
    expect(payload.max_tokens).toBe(4096);
    expect(payload.temperature).toBe(1);
  });

  it("passes a default image detail to OpenAI image parts", () => {
    const imageRequest = ChatRequestSchema.parse({
      messages: [
        {
          id: "u1",
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "abc" },
            },
          ],
        },
      ],
      max_tokens: 100,
    });

    const messages = toOpenAiMessages(imageRequest, "high");
    const content = messages[0]?.content as Array<{ image_url?: { detail?: string } }> | undefined;
    expect(content?.[0]?.image_url?.detail).toBe("high");
  });
});
