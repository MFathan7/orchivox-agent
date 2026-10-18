import type { ProviderProfile } from "../config/loader";

export interface OllamaCapabilities {
  toolCalling: boolean;
  reasoning: boolean;
  vision: boolean;
  contextWindow?: number;
  family?: string;
}

interface CacheEntry {
  value: OllamaCapabilities;
  at: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function nativeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function cacheKey(baseUrl: string, model: string): string {
  return `${nativeBase(baseUrl)}\u0000${model}`;
}

export function getCachedOllamaCapabilities(baseUrl: string, model: string): OllamaCapabilities | undefined {
  const key = cacheKey(baseUrl, model);
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function findContextWindow(modelInfo: unknown): number | undefined {
  if (!modelInfo || typeof modelInfo !== "object") return undefined;
  for (const [key, value] of Object.entries(modelInfo as Record<string, unknown>)) {
    if (!/context_length$/i.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

export async function inspectOllamaModel(
  baseUrl: string,
  model: string,
  signal?: AbortSignal,
): Promise<OllamaCapabilities | undefined> {
  const base = nativeBase(baseUrl);
  try {
    const response = await fetch(`${base}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: signal ?? AbortSignal.timeout(4000),
    });
    if (!response.ok) return undefined;
    const raw = (await response.json()) as {
      capabilities?: unknown;
      model_info?: unknown;
      details?: { family?: unknown };
    };
    const capabilities = Array.isArray(raw.capabilities)
      ? raw.capabilities.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    if (!capabilities) return undefined;
    const value: OllamaCapabilities = {
      toolCalling: capabilities.includes("tools"),
      reasoning: capabilities.includes("thinking"),
      vision: capabilities.includes("vision"),
      contextWindow: findContextWindow(raw.model_info),
      family: typeof raw.details?.family === "string" ? raw.details.family : undefined,
    };
    cache.set(cacheKey(base, model), { value, at: Date.now() });
    return value;
  } catch {
    return undefined;
  }
}

export async function warmOllamaProvider(profile: ProviderProfile): Promise<void> {
  const base = nativeBase(profile.base_url);
  try {
    const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return;
    const raw = (await response.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
    const names = (raw.models ?? [])
      .map((entry) => (typeof entry.model === "string" ? entry.model : typeof entry.name === "string" ? entry.name : ""))
      .filter((name) => name.length > 0);
    await Promise.all(names.map((name) => inspectOllamaModel(base, name)));
  } catch {
    // Ollama may be offline; capability inference falls back to the catalog or defaults.
  }
}
