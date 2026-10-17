import type { AppConfig, ProviderProfile } from "../config/loader";
import type { ChatRequest, StreamEvent } from "../types/schema";
import { AnthropicCompatProvider } from "./anthropic-compat";
import { OpenAICompatProvider } from "./openai-compat";

export interface LLMProvider {
  streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown>;
  listModels(signal?: AbortSignal): Promise<string[]>;
}

export type ProviderRole = "main" | "fast" | "advisor";

const ROLE_MODEL_KEYS: Record<ProviderRole, "main_model" | "fast_model" | "advisor_model"> = {
  main: "main_model",
  fast: "fast_model",
  advisor: "advisor_model",
};

export class ProviderRouter {
  private readonly config: AppConfig;
  private readonly instances = new Map<string, LLMProvider>();

  constructor(config: AppConfig) {
    this.config = config;
  }

  get(role: ProviderRole): LLMProvider {
    const ref = this.config.roles[ROLE_MODEL_KEYS[role]];
    if (!ref) throw new Error(`no model assigned for role "${role}" in the config roles section`);
    return this.provider(ref.provider, ref.model);
  }

  provider(profileName: string, model?: string): LLMProvider {
    const profile = this.config.providers[profileName];
    if (!profile) throw new Error(`unknown provider profile "${profileName}"`);
    if (!profile.enabled) throw new Error(`provider profile "${profileName}" is disabled`);
    const boundModel: string | undefined = model ?? profile.models[0];
    const key = `${profileName}\u0000${boundModel ?? ""}`;
    const cached = this.instances.get(key);
    if (cached) return cached;
    const created = createProvider(profile, boundModel);
    this.instances.set(key, created);
    return created;
  }
}

function createProvider(profile: ProviderProfile, model: string | undefined): LLMProvider {
  const options = {
    baseUrl: profile.base_url,
    apiKey: profile.api_key,
    headers: profile.headers,
    model,
    pricing: profile.pricing,
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
