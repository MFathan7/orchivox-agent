import { resolveModelCapabilities, type AppConfig, type ModeSettings, type ModelCapabilities, type ModelCapabilitiesPatch, type ProviderProfile } from "../config/loader";
import type { AgentMode, ChatRequest, StreamEvent } from "../types/schema";
import { AnthropicCompatProvider } from "./anthropic-compat";
import { catalogProviderForKind, findCatalogModel, type CatalogModel, type ModelCatalog } from "./model-catalog";
import { getCachedOllamaCapabilities } from "./ollama-introspect";
import { OpenAICompatProvider } from "./openai-compat";

export interface LLMProvider {
  streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown>;
  listModels(signal?: AbortSignal): Promise<string[]>;
}

export type ProviderRole = "main" | "fast" | "advisor";

export interface ProviderSummary {
  name: string;
  kind: string;
  baseUrl: string;
  enabled: boolean;
  models: string[];
  hasApiKey: boolean;
}

const ROLE_MODEL_KEYS: Record<ProviderRole, "main_model" | "fast_model" | "advisor_model"> = {
  main: "main_model",
  fast: "fast_model",
  advisor: "advisor_model",
};

export class ProviderRouter {
  private readonly config: AppConfig;
  private readonly catalog: ModelCatalog | undefined;
  private readonly instances = new Map<string, LLMProvider>();

  constructor(config: AppConfig, options: { catalog?: ModelCatalog } = {}) {
    this.config = config;
    this.catalog = options.catalog;
  }

  get(role: ProviderRole): LLMProvider {
    const ref = this.config.roles[ROLE_MODEL_KEYS[role]];
    if (!ref) throw new Error(`no model assigned for role "${role}" in the config roles section`);
    return this.provider(ref.provider, ref.model);
  }

  getRole(role: ProviderRole): { provider: string; model: string } | undefined {
    return this.config.roles[ROLE_MODEL_KEYS[role]];
  }

  setRole(role: ProviderRole, provider: string, model: string): void {
    const profile = this.config.providers[provider];
    if (!profile) throw new Error(`unknown provider profile "${provider}"`);
    this.config.roles[ROLE_MODEL_KEYS[role]] = { provider, model };
  }

  listAllConfiguredModels(): Array<{ provider: string; model: string; kind: string }> {
    const list: Array<{ provider: string; model: string; kind: string }> = [];
    for (const [providerName, profile] of Object.entries(this.config.providers)) {
      if (!profile.enabled) continue;
      for (const model of profile.models) {
        list.push({ provider: providerName, model, kind: profile.kind });
      }
    }
    return list;
  }

  capabilitiesFor(providerName: string, model?: string): ModelCapabilities {
    const profile = this.config.providers[providerName];
    if (!profile) throw new Error(`unknown provider profile "${providerName}"`);
    return this.capabilitiesForProfile(profile, model);
  }

  providerKind(providerName: string): string | undefined {
    return this.config.providers[providerName]?.kind;
  }

  capabilitiesForProfile(profile: ProviderProfile, model?: string): ModelCapabilities {
    const key = model ?? profile.models[0] ?? "";
    const catalogProvider = catalogProviderForKind(profile.kind, profile.catalog_provider);
    const catalogModel = findCatalogModel(this.catalog, catalogProvider, key);
    const ollama = profile.kind === "ollama" ? getCachedOllamaCapabilities(profile.base_url, key) : undefined;
    return resolveModelCapabilities(profile, model, { catalogModel, ollama });
  }

  capabilitiesForRole(role: ProviderRole): ModelCapabilities {
    const ref = this.getRole(role);
    if (!ref) {
      return {
        tool_calling: true,
        reasoning: false,
        vision: false,
        context_window: 32_768,
        max_output: 4_096,
        structured_output: false,
        temperature: true,
        pdf: false,
        parallel_tool_calls: true,
        source: "inferred",
      };
    }
    return this.capabilitiesFor(ref.provider, ref.model);
  }

  getMode(mode: AgentMode): LLMProvider {
    const model = this.config.modes[mode]?.model;
    return model ? this.provider(model.provider, model.model) : this.get("main");
  }

  getModeSettings(mode: AgentMode): ModeSettings {
    return this.config.modes[mode];
  }

  getModeModel(mode: AgentMode): { provider: string; model: string } | undefined {
    return this.config.modes[mode]?.model ?? this.getRole("main");
  }

  getModeReasoning(mode: AgentMode): string | undefined {
    return this.config.modes[mode]?.reasoning;
  }

  capabilitiesForMode(mode: AgentMode): ModelCapabilities {
    const model = this.config.modes[mode]?.model;
    return model ? this.capabilitiesFor(model.provider, model.model) : this.capabilitiesForRole("main");
  }

  reasoningOptionsForMode(mode: AgentMode): string[] {
    return this.reasoningOptionsFor(this.capabilitiesForMode(mode));
  }

  reasoningOptionsForRole(role: ProviderRole): string[] {
    return this.reasoningOptionsFor(this.capabilitiesForRole(role));
  }

  private reasoningOptionsFor(capabilities: ModelCapabilities): string[] {
    if (!capabilities.reasoning) return ["off"];
    const efforts = capabilities.reasoning_efforts?.length
      ? capabilities.reasoning_efforts
      : ["low", "medium", "high"];
    return ["off", ...new Set(efforts.map((value) => value.toLowerCase()))];
  }

  setModeModel(mode: AgentMode, provider: string, model: string): void {
    const profile = this.config.providers[provider];
    if (!profile) throw new Error(`unknown provider profile "${provider}"`);
    this.config.modes[mode] = { ...this.config.modes[mode], model: { provider, model } };
  }

  setModeReasoning(mode: AgentMode, reasoning: string): void {
    this.config.modes[mode] = { ...this.config.modes[mode], reasoning };
  }

  listCatalogModels(providerName: string): CatalogModel[] {
    const profile = this.config.providers[providerName];
    if (!profile) return [];
    const catalogProvider = catalogProviderForKind(profile.kind, profile.catalog_provider);
    const provider = catalogProvider ? this.catalog?.providers[catalogProvider] : undefined;
    return provider ? Object.values(provider.models) : [];
  }

  addModel(providerName: string, model: string): void {
    const profile = this.config.providers[providerName];
    if (!profile) throw new Error(`unknown provider profile "${providerName}"`);
    if (!profile.models.includes(model)) profile.models.push(model);
    for (const key of [...this.instances.keys()]) {
      if (key.startsWith(`${providerName}\u0000`)) this.instances.delete(key);
    }
  }

  capabilitiesOverrideFor(providerName: string, model: string): ModelCapabilitiesPatch | undefined {
    const profile = this.config.providers[providerName];
    if (!profile) throw new Error(`unknown provider profile "${providerName}"`);
    return profile.model_capabilities[model];
  }

  setModelCapabilities(providerName: string, model: string, patch?: ModelCapabilitiesPatch): void {
    const profile = this.config.providers[providerName];
    if (!profile) throw new Error(`unknown provider profile "${providerName}"`);
    if (patch === undefined) delete profile.model_capabilities[model];
    else profile.model_capabilities[model] = patch;
  }

  listProviders(): ProviderSummary[] {
    return Object.entries(this.config.providers).map(([name, profile]) => ({
      name,
      kind: profile.kind,
      baseUrl: profile.base_url,
      enabled: profile.enabled,
      models: [...profile.models],
      hasApiKey: Boolean(profile.api_key),
    }));
  }

  addProvider(name: string, profile: ProviderProfile): void {
    this.config.providers[name] = profile;
    for (const key of [...this.instances.keys()]) {
      if (key.startsWith(`${name}\u0000`)) this.instances.delete(key);
    }
  }

  async testProvider(profile: ProviderProfile): Promise<string[]> {
    const model = profile.models[0];
    const provider = createProvider(profile, model, this.capabilitiesForProfile(profile, model));
    return provider.listModels(AbortSignal.timeout(8000));
  }

  refresh(): void {
    this.instances.clear();
  }

  provider(profileName: string, model?: string): LLMProvider {
    const profile = this.config.providers[profileName];
    if (!profile) throw new Error(`unknown provider profile "${profileName}"`);
    if (!profile.enabled) throw new Error(`provider profile "${profileName}" is disabled`);
    const boundModel: string | undefined = model ?? profile.models[0];
    const key = `${profileName}\u0000${boundModel ?? ""}`;
    const cached = this.instances.get(key);
    if (cached) return cached;
    const created = createProvider(profile, boundModel, this.capabilitiesForProfile(profile, boundModel));
    this.instances.set(key, created);
    return created;
  }
}

function createProvider(
  profile: ProviderProfile,
  model: string | undefined,
  capabilities: ModelCapabilities,
): LLMProvider {
  const options = {
    baseUrl: profile.base_url,
    apiKey: profile.api_key,
    headers: profile.headers,
    model,
    pricing: profile.pricing,
    kind: profile.kind,
    capabilities,
  };
  switch (profile.kind) {
    case "openai":
    case "openrouter":
    case "ollama":
      return new OpenAICompatProvider(options);
    case "anthropic":
    case "openclaude":
      return new AnthropicCompatProvider(options);
    default:
      throw new Error(`unsupported provider kind "${String((profile as { kind: unknown }).kind)}"`);
  }
}
