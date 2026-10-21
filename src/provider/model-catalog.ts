import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ProviderKind } from "../config/loader";

export interface CatalogReasoningOption {
  type: string;
  values?: string[];
  min?: number;
  max?: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  family?: string;
  attachment: boolean;
  reasoning: boolean;
  reasoningOptions: CatalogReasoningOption[];
  toolCall: boolean;
  structuredOutput: boolean;
  temperature: boolean;
  modalities: { input: string[]; output: string[] };
  limit: { context?: number; input?: number; output?: number };
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  canonicalModelId?: string;
}

export interface CatalogProvider {
  name?: string;
  models: Record<string, CatalogModel>;
}

export interface ModelCatalog {
  providers: Record<string, CatalogProvider>;
  fetchedAt: number;
  etag?: string;
}

export interface LoadModelCatalogOptions {
  cachePath?: string;
  url?: string;
  ttlMs?: number;
  timeoutMs?: number;
  force?: boolean;
  fetcher?: typeof fetch;
}

const DEFAULT_URL = "https://models.dev/api.json";
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;

export function defaultCatalogCachePath(): string {
  const cacheHome = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(cacheHome, "orchivox", "models-dev.json");
}

export function emptyCatalog(): ModelCatalog {
  return { providers: {}, fetchedAt: 0 };
}

export function catalogProviderForKind(kind: ProviderKind, override?: string): string | undefined {
  if (override) return override;
  switch (kind) {
    case "openai":
      return "openai";
    case "anthropic":
    case "openclaude":
      return "anthropic";
    case "openrouter":
      return "openrouter";
    default:
      return undefined;
  }
}

export function catalogProviderForBaseUrl(baseUrl: string): string | undefined {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host === "integrate.api.nvidia.com" || host.endsWith(".nvidia.com")) return "nvidia";
  if (host === "api.openai.com") return "openai";
  if (host === "api.anthropic.com") return "anthropic";
  if (host === "openrouter.ai") return "openrouter";
  if (host === "generativelanguage.googleapis.com") return "google";
  if (host === "api.mistral.ai") return "mistral";
  if (host === "api.deepseek.com") return "deepseek";
  return undefined;
}

export function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/^[^/]+\//, "")
    .replace(/:(free|nitro|extended|thinking|online)$/g, "")
    .replace(/-latest$/, "")
    .replace(/(-\d{4}-\d{2}-\d{2}|-\d{8})$/, "")
    .replace(/[._]/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

interface NormalizedCatalogEntry {
  model: CatalogModel;
  normalized: string;
}

// Model IDs are normalized once per catalog provider instead of once per
// lookup. A full models.dev catalog has hundreds of providers, so doing the
// regex work inside every search makes opening /models take seconds.
const normalizedProviderCache = new WeakMap<CatalogProvider, NormalizedCatalogEntry[]>();
// Keyed by the provider map, not the catalog object: refreshModelCatalog
// replaces catalog.providers in place, so a catalog-keyed cache would go stale.
const lookupCache = new WeakMap<Record<string, CatalogProvider>, Map<string, CatalogModel | undefined>>();

function normalizedProviderModels(provider: CatalogProvider): NormalizedCatalogEntry[] {
  const cached = normalizedProviderCache.get(provider);
  if (cached) return cached;

  const entries: NormalizedCatalogEntry[] = [];
  for (const [id, model] of Object.entries(provider.models)) {
    for (const candidate of [id, model.canonicalModelId]) {
      if (!candidate) continue;
      const normalized = normalizeModelId(candidate);
      if (normalized) entries.push({ model, normalized });
    }
  }
  normalizedProviderCache.set(provider, entries);
  return entries;
}

function searchProviderModels(
  provider: CatalogProvider,
  modelId: string,
  target: string,
): { model: CatalogModel; distance: number } | undefined {
  const exact = provider.models[modelId];
  if (exact) return { model: exact, distance: 0 };

  let best: CatalogModel | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const { model, normalized } of normalizedProviderModels(provider)) {
    if (normalized === target) return { model, distance: 0 };
    if (normalized.startsWith(target) || target.startsWith(normalized)) {
      const distance = Math.abs(normalized.length - target.length);
      if (distance < bestDistance) {
        best = model;
        bestDistance = distance;
      }
    }
  }
  return best && bestDistance <= 24 ? { model: best, distance: bestDistance } : undefined;
}

export function findCatalogModel(
  catalog: ModelCatalog | undefined,
  providerId: string | undefined,
  modelId: string,
): CatalogModel | undefined {
  if (!catalog) return undefined;
  const target = normalizeModelId(modelId);
  if (!target) return undefined;

  const providers = catalog.providers;
  let cache = lookupCache.get(providers);
  if (!cache) {
    cache = new Map();
    lookupCache.set(providers, cache);
  }
  const cacheKey = `${providerId ?? ""}\u0000${modelId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let result: CatalogModel | undefined;
  if (providerId) {
    const provider = providers[providerId];
    if (provider) {
      const match = searchProviderModels(provider, modelId, target);
      if (match) result = match.model;
    }
  }

  // Cross-provider fallback for local, custom, or multi-provider models (e.g. Ollama, vLLM)
  if (!result) {
    let bestMatch: CatalogModel | undefined;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const provider of Object.values(providers)) {
      const match = searchProviderModels(provider, modelId, target);
      if (match) {
        if (match.distance === 0) {
          bestMatch = match.model;
          bestDist = 0;
          break;
        }
        if (match.distance < bestDist) {
          bestMatch = match.model;
          bestDist = match.distance;
        }
      }
    }
    result = bestDist <= 24 ? bestMatch : undefined;
  }

  cache.set(cacheKey, result);
  return result;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function parseReasoningOption(value: unknown): CatalogReasoningOption[] {
  if (!value || typeof value !== "object") return [];
  const raw = value as Record<string, unknown>;
  const type = typeof raw.type === "string" ? raw.type : undefined;
  if (!type) return [];
  return [
    {
      type,
      values: Array.isArray(raw.values)
        ? raw.values.filter((entry): entry is string => typeof entry === "string")
        : undefined,
      min: numberOrUndefined(raw.min),
      max: numberOrUndefined(raw.max),
    },
  ];
}

function parseModel(id: string, value: unknown): CatalogModel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const modalities = raw.modalities as { input?: unknown; output?: unknown } | undefined;
  const limit = raw.limit as { context?: unknown; input?: unknown; output?: unknown } | undefined;
  const cost = raw.cost as
    | { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown }
    | undefined;
  const reasoningOptions = Array.isArray(raw.reasoning_options)
    ? raw.reasoning_options.flatMap(parseReasoningOption)
    : [];

  return {
    id: typeof raw.id === "string" ? raw.id : id,
    name: typeof raw.name === "string" ? raw.name : id,
    family: typeof raw.family === "string" ? raw.family : undefined,
    attachment: raw.attachment === true,
    reasoning: raw.reasoning === true,
    reasoningOptions,
    toolCall: raw.tool_call !== false,
    structuredOutput: raw.structured_output === true,
    temperature: raw.temperature !== false,
    modalities: {
      input: stringArray(modalities?.input),
      output: stringArray(modalities?.output),
    },
    limit: {
      context: numberOrUndefined(limit?.context),
      input: numberOrUndefined(limit?.input),
      output: numberOrUndefined(limit?.output),
    },
    cost: cost
      ? {
          input: numberOrUndefined(cost.input),
          output: numberOrUndefined(cost.output),
          cacheRead: numberOrUndefined(cost.cache_read),
          cacheWrite: numberOrUndefined(cost.cache_write),
        }
      : undefined,
    canonicalModelId: typeof raw.canonical_model_id === "string" ? raw.canonical_model_id : undefined,
  };
}

export function parseCatalog(raw: unknown): ModelCatalog {
  const providers: Record<string, CatalogProvider> = {};
  if (!raw || typeof raw !== "object") return { providers, fetchedAt: Date.now() };

  for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const provider = value as { name?: unknown; models?: unknown };
    const models: Record<string, CatalogModel> = {};
    if (provider.models && typeof provider.models === "object") {
      for (const [modelId, modelValue] of Object.entries(provider.models as Record<string, unknown>)) {
        const normalized = parseModel(modelId, modelValue);
        if (normalized) models[modelId] = normalized;
      }
    }
    providers[providerId] = {
      name: typeof provider.name === "string" ? provider.name : undefined,
      models,
    };
  }

  return { providers, fetchedAt: Date.now() };
}

function readCatalogCache(cachePath: string): ModelCatalog | undefined {
  try {
    if (!existsSync(cachePath)) return undefined;
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as ModelCatalog;
    if (!parsed || typeof parsed !== "object" || !parsed.providers) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeCatalogCache(cachePath: string, catalog: ModelCatalog): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(catalog));
  } catch {
    // A cache write failure must never interrupt the agent.
  }
}

export function loadModelCatalogSync(options: LoadModelCatalogOptions = {}): ModelCatalog {
  return readCatalogCache(options.cachePath ?? defaultCatalogCachePath()) ?? emptyCatalog();
}

export async function loadModelCatalog(options: LoadModelCatalogOptions = {}): Promise<ModelCatalog> {
  const cachePath = options.cachePath ?? defaultCatalogCachePath();
  const url = options.url ?? process.env.ORCHIVOX_MODELS_CATALOG ?? DEFAULT_URL;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetcher ?? fetch;

  const cached = readCatalogCache(cachePath);
  if (cached && !options.force && cached.fetchedAt > 0 && Date.now() - cached.fetchedAt < ttlMs) {
    return cached;
  }

  try {
    const headers: Record<string, string> = { "user-agent": "orchivox-agent" };
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    const response = await fetcher(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 304 && cached) {
      const refreshed = { ...cached, fetchedAt: Date.now() };
      writeCatalogCache(cachePath, refreshed);
      return refreshed;
    }

    if (!response.ok) return cached ?? emptyCatalog();

    const catalog = parseCatalog(await response.json());
    catalog.etag = response.headers.get("etag") ?? undefined;
    writeCatalogCache(cachePath, catalog);
    return catalog;
  } catch {
    return cached ?? emptyCatalog();
  }
}

export async function refreshModelCatalog(
  target: ModelCatalog,
  options: LoadModelCatalogOptions = {},
): Promise<ModelCatalog> {
  const fresh = await loadModelCatalog(options);
  if (Object.keys(fresh.providers).length > 0) {
    target.providers = fresh.providers;
    target.fetchedAt = fresh.fetchedAt;
    target.etag = fresh.etag;
  }
  return target;
}
