import type { ProviderKind, ProviderProfile } from "../config/loader";
import type { TokenPricing } from "../types/schema";
import type { CatalogModel } from "./model-catalog";

function priceOrUndefined(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** models.dev reports cost in USD per million tokens, so the values map directly. */
export function pricingFromCatalog(cost: CatalogModel["cost"]): TokenPricing | undefined {
  if (!cost) return undefined;
  const input = priceOrUndefined(cost.input);
  const output = priceOrUndefined(cost.output);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = priceOrUndefined(cost.cacheRead);
  const cacheWrite = priceOrUndefined(cost.cacheWrite);
  return {
    input_usd_per_million_tokens: input,
    output_usd_per_million_tokens: output,
    ...(cacheRead !== undefined ? { cache_read_usd_per_million_tokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cache_creation_usd_per_million_tokens: cacheWrite } : {}),
  };
}

function cacheMultipliers(kind: ProviderKind): { read: number; write: number } {
  switch (kind) {
    case "anthropic":
    case "openclaude":
      // Anthropic charges 10% for a cache read and 125% for a 5-minute write.
      return { read: 0.1, write: 1.25 };
    case "openai":
    case "openrouter":
      // Cached input is usually billed at half price; writes have no separate fee.
      return { read: 0.5, write: 1 };
    case "ollama":
      return { read: 1, write: 1 };
  }
}

function withCacheDefaults(pricing: TokenPricing, kind: ProviderKind): TokenPricing {
  const input = pricing.input_usd_per_million_tokens;
  const multipliers = cacheMultipliers(kind);
  return {
    ...pricing,
    cache_read_usd_per_million_tokens:
      pricing.cache_read_usd_per_million_tokens ?? input * multipliers.read,
    cache_creation_usd_per_million_tokens:
      pricing.cache_creation_usd_per_million_tokens ?? input * multipliers.write,
  };
}

/**
 * Manual provider pricing wins over the catalog. Missing cache prices fall back
 * to the provider's usual ratios so partial manual pricing still bills caches.
 */
export function resolveProviderPricing(
  profile: Pick<ProviderProfile, "kind" | "pricing">,
  catalogCost: CatalogModel["cost"] | undefined,
): TokenPricing | undefined {
  if (profile.pricing) return withCacheDefaults(profile.pricing, profile.kind);
  const catalogPricing = pricingFromCatalog(catalogCost);
  return catalogPricing ? withCacheDefaults(catalogPricing, profile.kind) : undefined;
}
