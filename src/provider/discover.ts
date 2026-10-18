import type { ProviderKind } from "../config/loader";
import { OpenAICompatProvider } from "./openai-compat";

export interface DiscoveredProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  models: string[];
}

interface LocalTarget {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  tagsUrl?: string;
}

const LOCAL_TARGETS: LocalTarget[] = [
  {
    id: "ollama",
    name: "Ollama",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    tagsUrl: "http://127.0.0.1:11434/api/tags",
  },
  { id: "lmstudio", name: "LM Studio", kind: "openai", baseUrl: "http://127.0.0.1:1234/v1" },
  { id: "llamacpp", name: "llama.cpp", kind: "openai", baseUrl: "http://127.0.0.1:8080/v1" },
  { id: "vllm", name: "vLLM", kind: "openai", baseUrl: "http://127.0.0.1:8000/v1" },
];

const PROBE_TIMEOUT_MS = 1500;

async function fetchOllamaTags(tagsUrl: string): Promise<string[]> {
  const response = await fetch(tagsUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const parsed = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
  return (parsed.models ?? [])
    .map((entry) => entry.name ?? entry.model ?? "")
    .filter((name) => name.length > 0);
}

async function probe(target: LocalTarget): Promise<DiscoveredProvider | undefined> {
  try {
    const provider = new OpenAICompatProvider({ baseUrl: target.baseUrl });
    const models = await provider.listModels(AbortSignal.timeout(PROBE_TIMEOUT_MS));
    if (models.length > 0) {
      return { id: target.id, name: target.name, kind: target.kind, baseUrl: target.baseUrl, models };
    }
  } catch {
    // The OpenAI-compatible endpoint may be missing on older runtimes.
  }

  if (target.tagsUrl) {
    try {
      const models = await fetchOllamaTags(target.tagsUrl);
      if (models.length > 0) {
        return { id: target.id, name: target.name, kind: target.kind, baseUrl: target.baseUrl, models };
      }
    } catch {
      // Runtime is not running.
    }
  }

  return undefined;
}

export async function discoverLocalProviders(): Promise<DiscoveredProvider[]> {
  const results = await Promise.all(LOCAL_TARGETS.map((target) => probe(target)));
  return results.filter((entry): entry is DiscoveredProvider => entry !== undefined);
}
