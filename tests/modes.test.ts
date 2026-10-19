import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { parseConfig } from "../src/config/loader";
import {
  appendProviderModel,
  saveModeReasoning,
  saveModeSelection,
} from "../src/config/writer";
import { parseCatalog } from "../src/provider/model-catalog";
import { ProviderRouter } from "../src/provider/router";
import { reasoningLevelsFor } from "../src/tui/command-palette";

function testConfig() {
  return parseConfig({
    providers: {
      local: {
        kind: "ollama",
        base_url: "http://127.0.0.1:11434/v1",
        models: ["qwen3.5:9b"],
        model_capabilities: {
          "qwen3.5:9b": {
            reasoning: true,
            reasoning_efforts: ["low", "high"],
          },
        },
      },
      cloud: {
        kind: "openai",
        base_url: "https://api.openai.com/v1",
        models: ["gpt-4.1"],
      },
    },
    roles: {
      main_model: { provider: "cloud", model: "gpt-4.1" },
    },
    modes: {
      plan: {
        model: { provider: "local", model: "qwen3.5:9b" },
        reasoning: "high",
      },
    },
  });
}

describe("per-mode models and reasoning", () => {
  it("fills mode defaults when the config omits them", () => {
    const config = parseConfig({});
    expect(config.modes.plan).toEqual({});
    expect(config.modes.build).toEqual({});
    expect(config.modes.ultrawork).toEqual({});
    expect(config.prompt.style).toBe("auto");
    expect(config.websearch.enabled).toBe(true);
    expect(config.websearch.provider).toBe("random");
    expect(config.webfetch.enabled).toBe(true);
  });

  it("exposes the provider kind for prompt selection", () => {
    const router = new ProviderRouter(testConfig());
    expect(router.providerKind("local")).toBe("ollama");
    expect(router.providerKind("cloud")).toBe("openai");
    expect(router.providerKind("missing")).toBeUndefined();
  });

  it("resolves the mode model and falls back to the main role", () => {
    const router = new ProviderRouter(testConfig());
    expect(router.getModeModel("plan")).toEqual({ provider: "local", model: "qwen3.5:9b" });
    expect(router.getModeModel("build")).toEqual({ provider: "cloud", model: "gpt-4.1" });
    expect(router.getModeReasoning("plan")).toBe("high");
    expect(router.getModeReasoning("build")).toBeUndefined();
  });

  it("lists only the reasoning efforts the mode model supports", () => {
    const router = new ProviderRouter(testConfig());
    expect(router.reasoningOptionsForMode("plan")).toEqual(["off", "low", "high"]);
    expect(router.reasoningOptionsForMode("build")).toEqual(["off"]);
  });

  it("uses the mode provider and still falls back to main", () => {
    const router = new ProviderRouter(testConfig());
    expect(router.getMode("plan")).toBeDefined();
    expect(router.getMode("build")).toBeDefined();
  });

  it("adds a model to an existing provider without duplicating it", () => {
    const router = new ProviderRouter(testConfig());
    router.addModel("local", "qwen3.5:9b");
    router.addModel("local", "new-model");
    const models = router
      .listAllConfiguredModels()
      .filter((entry) => entry.provider === "local")
      .map((entry) => entry.model);
    expect(models).toEqual(["qwen3.5:9b", "new-model"]);
  });

  it("lists catalog models for a provider", () => {
    const catalog = parseCatalog({
      openai: {
        models: {
          "gpt-4.1": { id: "gpt-4.1", name: "GPT-4.1", tool_call: true },
          "gpt-5": { id: "gpt-5", name: "GPT-5", tool_call: true, reasoning: true },
        },
      },
    });
    const router = new ProviderRouter(testConfig(), { catalog });
    expect(router.listCatalogModels("cloud").map((model) => model.id)).toEqual([
      "gpt-4.1",
      "gpt-5",
    ]);
    expect(router.listCatalogModels("local")).toEqual([]);
  });

  it("writes mode selection, reasoning, and a catalog model to the config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orchivox-modes-"));
    const path = join(dir, "config.yaml");
    try {
      await Bun.write(
        path,
        [
          "version: 1",
          "providers:",
          "  local:",
          "    kind: ollama",
          "    base_url: http://127.0.0.1:11434/v1",
          "    models:",
          "      - qwen3.5:9b",
          "roles:",
          "  main_model:",
          "    provider: local",
          "    model: qwen3.5:9b",
        ].join("\n"),
      );

      await saveModeSelection(path, "plan", "local", "qwen3.5:9b");
      await saveModeReasoning(path, "plan", "high");
      await appendProviderModel(path, "local", "new-model");

      const parsed = parseYaml(await Bun.file(path).text()) as {
        modes: { plan: { model: unknown; reasoning: string } };
        providers: { local: { models: string[] } };
      };
      expect(parsed.modes.plan).toEqual({
        model: { provider: "local", model: "qwen3.5:9b" },
        reasoning: "high",
      });
      expect(parsed.providers.local.models).toEqual(["qwen3.5:9b", "new-model"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps known and model-specific reasoning efforts to picker rows", () => {
    const levels = reasoningLevelsFor(["off", "high", "custom"]);
    expect(levels.map((level) => level.id)).toEqual(["off", "high", "custom"]);
    expect(levels[0]?.label).toBe("Off");
    expect(levels[2]?.description).toContain("Model-specific");
  });
});
