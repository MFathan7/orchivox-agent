import { resolveModelCapabilities, type AppConfig, type ModeSettings, type ModelCapabilities, type ModelCapabilitiesPatch, type ProviderProfile } from "../config/loader";
import type { AgentMode, ChatRequest, StreamEvent } from "../types/schema";
import { AnthropicCompatProvider } from "./anthropic-compat";
import { OllamaNativeProvider } from "./ollama-native";
import {
  catalogProviderForBaseUrl,
  catalogProviderForKind,
  findCatalogModel,
  type CatalogModel,
  type ModelCatalog,
} from "./model-catalog";
import { getLearnedLimits } from "./limit-cache";
import { OpenAICompatProvider } from "./openai-compat";
import { getRuntimeMetadata } from "./runtime-metadata";

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

export interface ProviderReferences {
  roles: ProviderRole[];
  modes: AgentMode[];
}

const ROLE_MODEL_KEYS: Record<ProviderRole, "main_model" | "fast_model" | "advisor_model"> = {
  main: "main_model",
  fast: "fast_model",
  advisor: "advisor_model",
};

function catalogProviderForProfile(profile: ProviderProfile): string | undefined {
  if (profile.catalog_provider === "custom" || profile.catalog_provider === "local") {
    return catalogProviderForBaseUrl(profile.base_url);
  }
  return (
    profile.catalog_provider ??
    catalogProviderForBaseUrl(profile.base_url) ??
    catalogProviderForKind(profile.kind)
  );
}

export class ProviderRouter {
  private readonly config: AppConfig;
  private readonly catalog: ModelCatalog | undefined;
  private readonly instances = new Map<string, LLMProvider>();
  private readonly capabilityListeners = new Set<() => void>();

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
    const catalogProvider = catalogProviderForProfile(profile);
    const catalogModel = findCatalogModel(this.catalog, catalogProvider, key);
    const runtime = getRuntimeMetadata(profile.base_url, key);
    const learned = getLearnedLimits(profile.base_url, key);
    return resolveModelCapabilities(profile, model, { catalogModel, runtime, learned });
  }

  capabilitiesForRole(role: ProviderRole): ModelCapabilities {
    const ref = this.getRole(role);
    if (!ref) {
      return {
        tool_calling: true,
        reasoning: false,
        vision: false,
        context_window: 200_000,
        max_output: 32_000,
        structured_output: false,
        temperature: true,
        pdf: false,
        parallel_tool_calls: true,
        source: "default",
        limit_sources: { context: "default", output: "default" },
      };
    }
    return this.capabilitiesFor(ref.provider, ref.model);
  }

  onCapabilitiesChanged(listener: () => void): () => void {
    this.capabilityListeners.add(listener);
    return () => {
      this.capabilityListeners.delete(listener);
    };
  }

  notifyCapabilitiesChanged(): void {
    for (const listener of this.capabilityListeners) listener();
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
    const options = new Set<string>(["default"]);
    if (!capabilities.reasoning) return [...options];
    const efforts = capabilities.reasoning_efforts?.length
      ? capabilities.reasoning_efforts
      : ["low", "medium", "high"];
    for (const effort of efforts) {
      const value = effort.toLowerCase();
      if (value === "default" || value === "none") continue;
      options.add(value);
    }
    if (capabilities.reasoning_budget_max !== undefined) options.add("max");
    return [...options];
  }

  setModeModel(mode: AgentMode, provider: string, model: string): void {
    const profile = this.config.providers[provider];
    if (!profile) throw new Error(`unknown provider profile "${provider}"`);
    this.config.modes[mode] = { ...this.config.modes[mode], model: { provider, model } };
  }

  /** Drops every per-mode model pin so the main model answers in all modes. */
  clearModeModels(): void {
    for (const mode of ["plan", "build", "ultrawork"] as AgentMode[]) {
      const settings = this.config.modes[mode];
      if (!settings?.model) continue;
      const { model: _dropped, ...rest } = settings;
      this.config.modes[mode] = rest;
    }
  }

  /** Per-mode pins that override the main model, for the picker hint. */
  modeModelOverrides(): Array<{ mode: AgentMode; provider: string; model: string }> {
    return (["plan", "build", "ultrawork"] as AgentMode[]).flatMap((mode) => {
      const ref = this.config.modes[mode]?.model;
      return ref ? [{ mode, provider: ref.provider, model: ref.model }] : [];
    });
  }

  setModeReasoning(mode: AgentMode, reasoning: string): void {
    this.config.modes[mode] = { ...this.config.modes[mode], reasoning };
  }

  catalogModelFor(providerName: string, model: string): CatalogModel | undefined {
    const profile = this.config.providers[providerName];
    if (!profile) return undefined;
    return findCatalogModel(this.catalog, catalogProviderForProfile(profile), model);
  }

  listCatalogModels(providerName: string): CatalogModel[] {
    const profile = this.config.providers[providerName];
    if (!profile) return [];
    const catalogProvider = catalogProviderForProfile(profile);
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

  getProviderProfile(name: string): ProviderProfile | undefined {
    return this.config.providers[name];
  }

  referencesForProvider(name: string): ProviderReferences {
    const roles = (["main", "fast", "advisor"] as ProviderRole[]).filter(
      (role) => this.getRole(role)?.provider === name,
    );
    const modes = (["plan", "build", "ultrawork"] as AgentMode[]).filter(
      (mode) => this.config.modes[mode]?.model?.provider === name,
    );
    return { roles, modes };
  }

  referencesForModel(provider: string, model: string): ProviderReferences {
    const roles = (["main", "fast", "advisor"] as ProviderRole[]).filter((role) => {
      const ref = this.getRole(role);
      return ref?.provider === provider && ref.model === model;
    });
    const modes = (["plan", "build", "ultrawork"] as AgentMode[]).filter((mode) => {
      const ref = this.config.modes[mode]?.model;
      return ref?.provider === provider && ref.model === model;
    });
    return { roles, modes };
  }

  addProvider(name: string, profile: ProviderProfile): void {
    this.config.providers[name] = profile;
    for (const key of [...this.instances.keys()]) {
      if (key.startsWith(`${name}\u0000`)) this.instances.delete(key);
    }
  }

  setProviderEnabled(name: string, enabled: boolean): void {
    const profile = this.config.providers[name];
    if (!profile) throw new Error(`unknown provider profile "${name}"`);
    profile.enabled = enabled;
    for (const key of [...this.instances.keys()]) {
      if (key.startsWith(`${name}\u0000`)) this.instances.delete(key);
    }
  }

  setProviderModels(name: string, models: string[]): void {
    const profile = this.config.providers[name];
    if (!profile) throw new Error(`unknown provider profile "${name}"`);
    const removed = profile.models.filter((model) => !models.includes(model));
    profile.models = [...models];
    for (const model of removed) {
      delete profile.model_capabilities[model];
      for (const role of ["main", "fast", "advisor"] as ProviderRole[]) {
        const ref = this.getRole(role);
        if (ref?.provider === name && ref.model === model) {
          delete this.config.roles[ROLE_MODEL_KEYS[role]];
        }
      }
      for (const mode of ["plan", "build", "ultrawork"] as AgentMode[]) {
        const ref = this.config.modes[mode]?.model;
        if (ref?.provider === name && ref.model === model) {
          delete this.config.modes[mode].model;
        }
      }
    }
    for (const key of [...this.instances.keys()]) {
      if (key.startsWith(`${name}\u0000`)) this.instances.delete(key);
    }
  }

  removeProvider(name: string): void {
    delete this.config.providers[name];
    for (const role of ["main", "fast", "advisor"] as ProviderRole[]) {
      if (this.getRole(role)?.provider === name) {
        delete this.config.roles[ROLE_MODEL_KEYS[role]];
      }
    }
    for (const mode of ["plan", "build", "ultrawork"] as AgentMode[]) {
      if (this.config.modes[mode]?.model?.provider === name) {
        delete this.config.modes[mode].model;
      }
    }
    for (const key of [...this.instances.keys()]) {
      if (key.startsWith(`${name}\u0000`)) this.instances.delete(key);
    }
  }

  removeModel(provider: string, model: string): void {
    const profile = this.config.providers[provider];
    if (!profile) throw new Error(`unknown provider profile "${provider}"`);
    profile.models = profile.models.filter((entry) => entry !== model);
    delete profile.model_capabilities[model];
    for (const role of ["main", "fast", "advisor"] as ProviderRole[]) {
      const ref = this.getRole(role);
      if (ref?.provider === provider && ref.model === model) {
        delete this.config.roles[ROLE_MODEL_KEYS[role]];
      }
    }
    for (const mode of ["plan", "build", "ultrawork"] as AgentMode[]) {
      const ref = this.config.modes[mode]?.model;
      if (ref?.provider === provider && ref.model === model) {
        delete this.config.modes[mode].model;
      }
    }
    for (const key of [...this.instances.keys()]) {
      if (key.startsWith(`${provider}\u0000`)) this.instances.delete(key);
    }
  }

  async testProvider(profile: ProviderProfile): Promise<string[]> {
    const model = profile.models[0];
    const provider = createProvider(profile, model, this.capabilitiesForProfile(profile, model));
    return provider.listModels(AbortSignal.timeout(8000));
  }

  refresh(): void {
    this.instances.clear();
    this.notifyCapabilitiesChanged();
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
    timeoutMs: profile.timeout_ms,
  };
  switch (profile.kind) {
    case "ollama":
      // The native endpoint is required for options.num_ctx: the OpenAI
      // compatible one silently cuts long prompts at the server default.
      return new OllamaNativeProvider(options);
    case "openai":
    case "openrouter":
      return new OpenAICompatProvider(options);
    case "anthropic":
    case "openclaude":
      return new AnthropicCompatProvider(options);
    default:
      throw new Error(`unsupported provider kind "${String((profile as { kind: unknown }).kind)}"`);
  }
}
