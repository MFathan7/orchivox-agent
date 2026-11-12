import type { ProviderProfile } from "../config/loader";
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

export function resolveProviderPricing(
  profile: Pick<ProviderProfile, "kind" | "pricing">,
  catalogCost: CatalogModel["cost"] | undefined,
): TokenPricing | undefined {
  return profile.pricing ?? pricingFromCatalog(catalogCost);
}
