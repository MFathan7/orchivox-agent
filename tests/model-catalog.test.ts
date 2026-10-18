import { describe, expect, it } from "bun:test";

import {
  ProviderProfileSchema,
  inferModelCapabilities,
  resolveModelCapabilities,
} from "../src/config/loader";
import {
  catalogProviderForKind,
  findCatalogModel,
  parseCatalog,
} from "../src/provider/model-catalog";

const rawCatalog = {
  anthropic: {
    name: "Anthropic",
    models: {
      "claude-opus-4-5": {
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5",
        family: "claude-opus",
        attachment: true,
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high"] },
          { type: "budget_tokens", min: 1024 },
        ],
        tool_call: true,
        structured_output: true,
        temperature: true,
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        limit: { context: 200000, output: 64000 },
        canonical_model_id: "anthropic/claude-opus-4-5",
      },
      "claude-sonnet-4-5-20250929": {
        id: "claude-sonnet-4-5-20250929",
        name: "Claude Sonnet 4.5",
        attachment: true,
        reasoning: true,
        tool_call: true,
        structured_output: true,
        temperature: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 200000, output: 64000 },
      },
    },
  },
  openai: {
    name: "OpenAI",
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
        tool_call: true,
        structured_output: true,
        temperature: true,
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        limit: { context: 1050000, output: 128000 },
        reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
      },
    },
  },
};

const catalog = parseCatalog(rawCatalog);

const anthropicProfile = ProviderProfileSchema.parse({
  kind: "anthropic",
  base_url: "https://api.anthropic.com",
  models: ["claude-opus-4-5"],
});

describe("model catalog and capability resolution", () => {
  it("maps provider kinds to catalog providers", () => {
    expect(catalogProviderForKind("openai")).toBe("openai");
    expect(catalogProviderForKind("anthropic")).toBe("anthropic");
    expect(catalogProviderForKind("openclaude")).toBe("anthropic");
    expect(catalogProviderForKind("openrouter")).toBe("openrouter");
    expect(catalogProviderForKind("ollama")).toBeUndefined();
    expect(catalogProviderForKind("openai", "custom")).toBe("custom");
  });

  it("finds models by exact, normalized, and date-suffixed ids", () => {
    expect(findCatalogModel(catalog, "anthropic", "claude-opus-4-5")?.name).toBe("Claude Opus 4.5");
    expect(findCatalogModel(catalog, "anthropic", "claude-opus-4.5")?.name).toBe("Claude Opus 4.5");
    expect(findCatalogModel(catalog, "anthropic", "claude-sonnet-4-5")?.name).toBe("Claude Sonnet 4.5");
    expect(findCatalogModel(catalog, "anthropic", "missing-model")).toBeUndefined();
  });

  it("resolves catalog capabilities including vision, reasoning, and limits", () => {
    const model = findCatalogModel(catalog, "anthropic", "claude-opus-4-5");
    const capabilities = resolveModelCapabilities(anthropicProfile, "claude-opus-4-5", { catalogModel: model });

    expect(capabilities.source).toBe("catalog");
    expect(capabilities.tool_calling).toBe(true);
    expect(capabilities.reasoning).toBe(true);
    expect(capabilities.vision).toBe(true);
    expect(capabilities.pdf).toBe(true);
    expect(capabilities.structured_output).toBe(true);
    expect(capabilities.context_window).toBe(200000);
    expect(capabilities.max_output).toBe(64000);
    expect(capabilities.reasoning_efforts).toEqual(["low", "medium", "high"]);
    expect(capabilities.reasoning_budget_min).toBe(1024);
  });

  it("lets explicit overrides win over the catalog", () => {
    const profile = ProviderProfileSchema.parse({
      kind: "anthropic",
      base_url: "https://api.anthropic.com",
      models: ["claude-opus-4-5"],
      model_capabilities: {
        "claude-opus-4-5": { vision: false, context_window: 100000 },
      },
    });
    const model = findCatalogModel(catalog, "anthropic", "claude-opus-4-5");
    const capabilities = resolveModelCapabilities(profile, "claude-opus-4-5", { catalogModel: model });

    expect(capabilities.source).toBe("override");
    expect(capabilities.vision).toBe(false);
    expect(capabilities.context_window).toBe(100000);
    expect(capabilities.structured_output).toBe(true);
  });

  it("prefers live Ollama capabilities and falls back to inference", () => {
    const ollamaProfile = ProviderProfileSchema.parse({
      kind: "ollama",
      base_url: "http://127.0.0.1:11434",
      models: ["qwen3.5:9b"],
    });
    const live = resolveModelCapabilities(ollamaProfile, "qwen3.5:9b", {
      ollama: { toolCalling: true, reasoning: true, vision: true, contextWindow: 262144 },
    });
    expect(live.source).toBe("ollama");
    expect(live.reasoning).toBe(true);
    expect(live.vision).toBe(true);
    expect(live.context_window).toBe(262144);

    const inferred = inferModelCapabilities("anthropic", "claude-sonnet-4");
    expect(inferred.vision).toBe(true);
    expect(inferred.reasoning).toBe(true);
  });
});
