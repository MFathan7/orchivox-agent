import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { LearnedModelLimits } from "../config/loader";
import { normalizeOrigin } from "./runtime-metadata";

interface LearnedRecord extends LearnedModelLimits {
  evidence?: string;
  at: number;
}

const MIN_LIMIT = 1_024;
const MAX_LIMIT = 10_000_000;

const store = new Map<string, LearnedRecord>();
const listeners = new Set<() => void>();
let loaded = false;

export function defaultLimitCachePath(): string {
  return (
    process.env.ORCHIVOX_LIMITS_CACHE?.trim() ||
    join(process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "orchivox", "model-limits.json")
  );
}

function cacheKey(baseUrl: string, model: string): string {
  return `${normalizeOrigin(baseUrl).toLowerCase()}\u0000${model}`;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const path = defaultLimitCachePath();
  try {
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      store.set(key, {
        contextWindow: validLimit(record.contextWindow),
        maxInput: validLimit(record.maxInput),
        maxOutput: validLimit(record.maxOutput),
        evidence: typeof record.evidence === "string" ? record.evidence : undefined,
        at: typeof record.at === "number" ? record.at : Date.now(),
      });
    }
  } catch {
    // A broken cache must never block a run.
  }
}

function validLimit(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_LIMIT &&
    value <= MAX_LIMIT
    ? Math.round(value)
    : undefined;
}

function persist(): void {
  const path = defaultLimitCachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const payload: Record<string, LearnedRecord> = {};
    for (const [key, value] of store) payload[key] = value;
    writeFileSync(path, JSON.stringify(payload, null, 2));
  } catch {
    // Cache persistence is best effort.
  }
}

export function getLearnedLimits(baseUrl: string, model: string): LearnedModelLimits | undefined {
  ensureLoaded();
  const record = store.get(cacheKey(baseUrl, model));
  if (!record) return undefined;
  return {
    contextWindow: record.contextWindow,
    maxInput: record.maxInput,
    maxOutput: record.maxOutput,
  };
}

export function getLearnedLimitRecord(
  baseUrl: string,
  model: string,
): (LearnedModelLimits & { evidence?: string; at: number }) | undefined {
  ensureLoaded();
  return store.get(cacheKey(baseUrl, model));
}

export function recordLearnedLimits(
  baseUrl: string,
  model: string,
  limits: LearnedModelLimits,
  evidence?: string,
): boolean {
  ensureLoaded();
  const contextWindow = validLimit(limits.contextWindow);
  const maxInput = validLimit(limits.maxInput);
  const maxOutput = validLimit(limits.maxOutput);
  if (contextWindow === undefined && maxInput === undefined && maxOutput === undefined) {
    return false;
  }
  const key = cacheKey(baseUrl, model);
  const previous = store.get(key);
  const next: LearnedRecord = {
    contextWindow: contextWindow ?? previous?.contextWindow,
    maxInput: maxInput ?? previous?.maxInput,
    maxOutput: maxOutput ?? previous?.maxOutput,
    evidence: evidence?.slice(0, 400),
    at: Date.now(),
  };
  if (
    previous &&
    previous.contextWindow === next.contextWindow &&
    previous.maxInput === next.maxInput &&
    previous.maxOutput === next.maxOutput
  ) {
    return false;
  }
  store.set(key, next);
  persist();
  for (const listener of listeners) listener();
  return true;
}

export function clearLearnedLimits(baseUrl?: string, model?: string): void {
  ensureLoaded();
  if (baseUrl === undefined) {
    store.clear();
  } else if (model === undefined) {
    const prefix = `${normalizeOrigin(baseUrl).toLowerCase()}\u0000`;
    for (const key of [...store.keys()]) {
      if (key.startsWith(prefix)) store.delete(key);
    }
  } else {
    store.delete(cacheKey(baseUrl, model));
  }
  persist();
}

export function subscribeLearnedLimits(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

interface LimitPattern {
  field: keyof LearnedModelLimits;
  pattern: RegExp;
}

const LIMIT_PATTERNS: LimitPattern[] = [
  { field: "contextWindow", pattern: /max_total_tokens\s*[=:]\s*(\d{3,})/gi },
  { field: "contextWindow", pattern: /max_model_len\s*[=:]\s*(\d{3,})/gi },
  {
    field: "contextWindow",
    pattern: /max(?:imum)?\s+context\s+(?:length|window)\s*(?:is|of|:|=)?\s*(\d{3,})/gi,
  },
  {
    field: "contextWindow",
    pattern: /context\s+(?:length|window)\s*(?:is|of|:|=)\s*(\d{3,})/gi,
  },
  {
    field: "contextWindow",
    pattern: /(?:tokens?|prompt)\s*>\s*(\d{3,})\s*(?:maximum|max|tokens?)/gi,
  },
  {
    field: "contextWindow",
    pattern: /max(?:imum)?\s+seq(?:uence)?\s+len(?:gth)?\s*[=:]?\s*\(?(\d{3,})\)?/gi,
  },
  { field: "maxInput", pattern: /max_input_tokens\s*[=:]\s*(\d{3,})/gi },
  { field: "maxOutput", pattern: /max_output_tokens\s*[=:]\s*(\d{3,})/gi },
];

export function parseLimitsFromError(message: string): LearnedModelLimits {
  const limits: LearnedModelLimits = {};
  for (const { field, pattern } of LIMIT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(message)) !== null) {
      const value = validLimit(Number.parseInt(match[1], 10));
      if (value === undefined) continue;
      limits[field] = limits[field] ?? value;
    }
  }
  return limits;
}

export function learnLimitsFromError(
  baseUrl: string,
  model: string,
  message: string,
): LearnedModelLimits | undefined {
  const limits = parseLimitsFromError(message);
  if (limits.contextWindow === undefined && limits.maxInput === undefined && limits.maxOutput === undefined) {
    return undefined;
  }
  const changed = recordLearnedLimits(baseUrl, model, limits, message);
  return changed ? limits : undefined;
}
