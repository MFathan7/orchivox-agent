import type { ProviderProfile, RuntimeModelMetadata } from "../config/loader";

export interface RuntimeDiscovery {
  models: string[];
  limits: Map<string, RuntimeModelMetadata>;
}

interface CacheEntry extends RuntimeDiscovery {
  at: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 2_000;
const OLLAMA_TIMEOUT_MS = 4_000;

const cache = new Map<string, CacheEntry>();

export function normalizeOrigin(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export function runtimeCacheKey(baseUrl: string): string {
  return normalizeOrigin(baseUrl).toLowerCase();
}

export function getRuntimeMetadata(
  baseUrl: string,
  model: string,
): RuntimeModelMetadata | undefined {
  const entry = cache.get(runtimeCacheKey(baseUrl));
  return entry?.limits.get(model);
}

export function getRuntimeDiscovery(baseUrl: string): RuntimeDiscovery | undefined {
  const entry = cache.get(runtimeCacheKey(baseUrl));
  if (!entry) return undefined;
  return { models: entry.models, limits: entry.limits };
}

export function setRuntimeDiscovery(baseUrl: string, discovery: RuntimeDiscovery): void {
  cache.set(runtimeCacheKey(baseUrl), { ...discovery, at: Date.now() });
}

export function clearRuntimeMetadata(): void {
  cache.clear();
}

function requestHeaders(profile: ProviderProfile): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(profile.api_key ? { authorization: `Bearer ${profile.api_key}` } : {}),
    ...profile.headers,
  };
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown | undefined> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function firstPositive(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = positive(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function booleanValue(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function readModelId(item: Record<string, unknown>): string | undefined {
  const id = item.id ?? item.model ?? item.key ?? item.name;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function limitsFromModel(item: Record<string, unknown>): RuntimeModelMetadata {
  const limits = asRecord(item.limits);
  const limit = asRecord(item.limit);
  const topProvider = asRecord(item.top_provider);
  const capabilities = asRecord(item.capabilities);
  const contextWindow = firstPositive(
    item.max_model_len,
    item.context_length,
    item.context_window,
    item.max_context_length,
    item.max_input_tokens,
    item.contextWindow,
    item.maxInputTokens,
    topProvider?.context_length,
    limit?.context,
    limits?.context,
  );
  const maxInput = firstPositive(
    item.max_input_tokens,
    item.maxInputTokens,
    limit?.input,
    limits?.input,
  );
  const maxOutput = firstPositive(
    item.max_output_tokens,
    item.maxOutputTokens,
    item.max_output,
    limit?.output,
    limits?.output,
  );
  return {
    contextWindow,
    maxInput,
    maxOutput,
    toolCalling: booleanValue(
      capabilities?.tools,
      item.supports_function_calling,
      item.supports_tool_choice,
    ),
    vision: booleanValue(capabilities?.vision, item.supports_vision),
    reasoning: booleanValue(capabilities?.reasoning, item.supports_reasoning),
  };
}

export function parseOpenAiModelList(raw: unknown): RuntimeDiscovery {
  const record = asRecord(raw);
  const items = Array.isArray(raw) ? raw : asArray(record?.data ?? record?.models);
  const limits = new Map<string, RuntimeModelMetadata>();
  const models: string[] = [];
  for (const entry of items) {
    const item = asRecord(entry);
    if (!item) continue;
    const id = readModelId(item);
    if (!id) continue;
    models.push(id);
    limits.set(id, limitsFromModel(item));
  }
  return { models, limits };
}

export function parseLiteLlmModelInfo(raw: unknown): RuntimeDiscovery {
  const record = asRecord(raw);
  const items = asArray(record?.data ?? record?.models);
  const limits = new Map<string, RuntimeModelMetadata>();
  const models: string[] = [];
  for (const entry of items) {
    const item = asRecord(entry);
    if (!item) continue;
    const id =
      typeof item.model_name === "string"
        ? item.model_name
        : typeof item.model === "string"
          ? item.model
          : typeof item.id === "string"
            ? item.id
            : undefined;
    if (!id) continue;
    const info = asRecord(item.model_info) ?? {};
    const input = positive(info.max_input_tokens);
    const total = positive(info.max_tokens);
    const output = positive(info.max_output_tokens);
    models.push(id);
    limits.set(id, {
      contextWindow: input ?? total,
      maxInput: input,
      maxOutput: output,
      toolCalling: booleanValue(info.supports_function_calling),
      vision: booleanValue(info.supports_vision),
      reasoning: booleanValue(info.supports_reasoning),
    });
  }
  return { models, limits };
}

export function parseLmStudioModels(raw: unknown): RuntimeDiscovery {
  const record = asRecord(raw);
  const items = asArray(record?.models ?? record?.data);
  const limits = new Map<string, RuntimeModelMetadata>();
  const models: string[] = [];
  for (const entry of items) {
    const item = asRecord(entry);
    if (!item) continue;
    if (typeof item.type === "string" && item.type !== "llm") continue;
    const id =
      typeof item.key === "string"
        ? item.key
        : typeof item.id === "string"
          ? item.id
          : undefined;
    if (!id) continue;
    const loaded = asArray(item.loaded_instances).flatMap((instance) => {
      const value = asRecord(instance);
      const config = asRecord(value?.config);
      const context = positive(config?.context_length);
      return context === undefined ? [] : [context];
    });
    const loadedContext = loaded.length > 0 ? Math.min(...loaded) : undefined;
    const capabilities = asRecord(item.capabilities);
    models.push(id);
    limits.set(id, {
      contextWindow: loadedContext ?? positive(item.max_context_length),
      toolCalling: booleanValue(capabilities?.trained_for_tool_use),
      vision: booleanValue(capabilities?.vision),
    });
  }
  return { models, limits };
}

export function parseLlamaCppProps(raw: unknown): RuntimeModelMetadata {
  const record = asRecord(raw);
  if (!record) return {};
  const settings = asRecord(record.default_generation_settings);
  const modelInfo = asRecord(record.model_info);
  let contextWindow = firstPositive(settings?.n_ctx, record.n_ctx);
  if (contextWindow === undefined && modelInfo) {
    for (const [key, value] of Object.entries(modelInfo)) {
      if (/context_length$/i.test(key)) {
        contextWindow = positive(value);
        if (contextWindow !== undefined) break;
      }
    }
  }
  return { contextWindow };
}

export function parseOllamaShow(raw: unknown): RuntimeModelMetadata {
  const record = asRecord(raw);
  if (!record) return {};
  const capabilities = asArray(record.capabilities).filter(
    (entry): entry is string => typeof entry === "string",
  );
  const modelInfo = asRecord(record.model_info) ?? {};
  let contextWindow: number | undefined;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (!/context_length$/i.test(key)) continue;
    contextWindow = positive(value);
    if (contextWindow !== undefined) break;
  }
  const details = asRecord(record.details);
  if (contextWindow === undefined && details?.context_length !== undefined) {
    contextWindow = positive(details.context_length);
  }
  return {
    contextWindow,
    toolCalling: capabilities.length > 0 ? capabilities.includes("tools") : undefined,
    reasoning: capabilities.length > 0 ? capabilities.includes("thinking") : undefined,
    vision: capabilities.length > 0 ? capabilities.includes("vision") : undefined,
    family: typeof details?.family === "string" ? details.family : undefined,
  };
}

export function mergeRuntimeLimit(
  target: RuntimeModelMetadata,
  incoming: RuntimeModelMetadata,
): RuntimeModelMetadata {
  return {
    contextWindow: target.contextWindow ?? incoming.contextWindow,
    maxInput: target.maxInput ?? incoming.maxInput,
    maxOutput: target.maxOutput ?? incoming.maxOutput,
    toolCalling: target.toolCalling ?? incoming.toolCalling,
    reasoning: target.reasoning ?? incoming.reasoning,
    vision: target.vision ?? incoming.vision,
    family: target.family ?? incoming.family,
  };
}

function mergeDiscovery(target: Map<string, RuntimeModelMetadata>, incoming: RuntimeDiscovery): void {
  for (const [model, limits] of incoming.limits) {
    const current = target.get(model);
    target.set(model, current ? mergeRuntimeLimit(current, limits) : limits);
  }
}

function needsMoreLimits(discovery: RuntimeDiscovery, models: string[]): boolean {
  if (models.length === 0) return discovery.limits.size === 0;
  return models.some((model) => discovery.limits.get(model)?.contextWindow === undefined);
}

async function probeOpenAiInventory(
  profile: ProviderProfile,
  models: string[],
  limits: Map<string, RuntimeModelMetadata>,
): Promise<void> {
  const base = profile.base_url.replace(/\/+$/, "");
  const origin = normalizeOrigin(profile.base_url);
  const headers = requestHeaders(profile);

  const list = parseOpenAiModelList(
    await fetchJson(`${base}/models`, { headers, method: "GET" }),
  );
  mergeDiscovery(limits, list);

  if (!needsMoreLimits(list, models)) return;

  const [litellm, lmstudio, llamacpp] = await Promise.all([
    fetchJson(`${base}/model/info`, { headers, method: "GET" }).then(parseLiteLlmModelInfo),
    fetchJson(`${origin}/api/v1/models`, { headers, method: "GET" }).then(parseLmStudioModels),
    fetchJson(`${origin}/props`, { headers, method: "GET" }).then((raw) => {
      const limits = new Map<string, RuntimeModelMetadata>();
      const props = parseLlamaCppProps(raw);
      if (props.contextWindow !== undefined && models.length === 1) {
        limits.set(models[0], props);
      }
      return { models: models.length === 1 ? models : [], limits };
    }),
  ]);

  mergeDiscovery(limits, litellm);
  mergeDiscovery(limits, lmstudio);
  mergeDiscovery(limits, llamacpp);

  if (models.length > 0) {
    for (const model of models) {
      if (!limits.has(model)) limits.set(model, {});
    }
  }
}

async function probeOllama(
  profile: ProviderProfile,
  models: string[],
  limits: Map<string, RuntimeModelMetadata>,
): Promise<void> {
  const origin = normalizeOrigin(profile.base_url);
  const headers = requestHeaders(profile);
  const tags = asRecord(
    await fetchJson(`${origin}/api/tags`, { headers, method: "GET" }, OLLAMA_TIMEOUT_MS),
  );
  const installed: string[] = [];
  for (const entry of asArray(tags?.models)) {
    const item = asRecord(entry);
    const name =
      typeof item?.model === "string"
        ? item.model
        : typeof item?.name === "string"
          ? item.name
          : undefined;
    if (name) {
      installed.push(name);
      const tagMetadata = parseOllamaShow(item);
      const current = limits.get(name);
      limits.set(name, current ? mergeRuntimeLimit(current, tagMetadata) : tagMetadata);
    }
  }
  const targets = models.length > 0 ? models : installed;
  await Promise.all(
    targets.slice(0, 64).map(async (model) => {
      const raw = await fetchJson(
        `${origin}/api/show`,
        { headers, method: "POST", body: JSON.stringify({ model }) },
        OLLAMA_TIMEOUT_MS,
      );
      const metadata = parseOllamaShow(raw);
      const current = limits.get(model);
      limits.set(model, current ? mergeRuntimeLimit(current, metadata) : metadata);
    }),
  );
}

export async function refreshRuntimeMetadata(profile: ProviderProfile): Promise<RuntimeDiscovery> {
  const models = [...profile.models];
  const limits = new Map<string, RuntimeModelMetadata>();
  const key = runtimeCacheKey(profile.base_url);

  if (profile.kind === "ollama") {
    await probeOllama(profile, models, limits);
  } else if (profile.kind !== "anthropic") {
    await probeOpenAiInventory(profile, models, limits);
  }

  const discovery: RuntimeDiscovery = { models, limits };
  cache.set(key, { ...discovery, at: Date.now() });
  return discovery;
}

export async function primeRuntimeMetadata(
  profiles: Record<string, ProviderProfile>,
  options: { force?: boolean } = {},
): Promise<void> {
  const entries = Object.values(profiles).filter((profile) => profile.enabled);
  await Promise.all(
    entries.map(async (profile) => {
      const cached = cache.get(runtimeCacheKey(profile.base_url));
      if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) return;
      await refreshRuntimeMetadata(profile).catch(() => undefined);
    }),
  );
}
