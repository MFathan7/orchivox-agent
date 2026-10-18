import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseDocument, type Document } from "yaml";

import type { ModelCapabilitiesPatch, ProviderProfile } from "./loader";

export type ConfigRole = "main" | "fast" | "advisor";

const ROLE_KEYS: Record<ConfigRole, string> = {
  main: "main_model",
  fast: "fast_model",
  advisor: "advisor_model",
};

async function readDocument(path: string): Promise<Document> {
  try {
    const raw = await readFile(path, "utf8");
    return parseDocument(raw);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const document = parseDocument("");
    document.set("version", 1);
    return document;
  }
}

async function writeDocument(path: string, document: Document): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, document.toString());
}

function ensureMap(document: Document, key: string): void {
  const node = document.get(key, true);
  if (node === undefined || node === null || typeof node !== "object") {
    document.set(key, document.createNode({}));
  }
}

export interface SaveProviderInput {
  configPath: string;
  secretsPath: string;
  name: string;
  profile: ProviderProfile;
  apiKey?: string;
}

export async function saveProviderProfile(input: SaveProviderInput): Promise<void> {
  const { configPath, secretsPath, name, profile, apiKey } = input;

  if (apiKey && apiKey.trim().length > 0) {
    const secrets = await readDocument(secretsPath);
    ensureMap(secrets, "providers");
    secrets.setIn(["providers", name, "api_key"], apiKey.trim());
    await writeDocument(secretsPath, secrets);
  }

  const document = await readDocument(configPath);
  ensureMap(document, "providers");

  const { api_key: _ignored, ...storedProfile } = profile;
  document.setIn(["providers", name], storedProfile);
  await writeDocument(configPath, document);
}

export async function saveRoleSelection(
  configPath: string,
  role: ConfigRole,
  provider: string,
  model: string,
): Promise<void> {
  const document = await readDocument(configPath);
  ensureMap(document, "roles");
  document.setIn(["roles", ROLE_KEYS[role]], { provider, model });
  await writeDocument(configPath, document);
}

export async function saveModelCapabilities(
  configPath: string,
  provider: string,
  model: string,
  patch: ModelCapabilitiesPatch | undefined,
): Promise<void> {
  const document = await readDocument(configPath);
  ensureMap(document, "providers");
  if (patch === undefined) {
    document.deleteIn(["providers", provider, "model_capabilities", model]);
  } else {
    document.setIn(["providers", provider, "model_capabilities", model], patch);
  }
  await writeDocument(configPath, document);
}
