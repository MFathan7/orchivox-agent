import type { Usage } from "../types/schema";

export function btwUsage(usage?: Usage, interrupted = false): Usage {
  return {
    ...(usage ?? { prompt_tokens: 0, completion_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    cost_incomplete: interrupted || !usage || usage.cost_incomplete || usage.cost_usd === undefined,
  };
}
