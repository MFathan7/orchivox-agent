import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isSeq, parseDocument, type Document } from "yaml";

import type { ModelCapabilitiesPatch, ProviderProfile } from "./loader";

export type ConfigRole = "main" | "fast" | "advisor";
export type ConfigMode = "plan" | "build" | "ultrawork";

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

export async function saveModeSelection(
  configPath: string,
  mode: ConfigMode,
  provider: string,
  model: string,
): Promise<void> {
  const document = await readDocument(configPath);
  ensureMap(document, "modes");
  document.setIn(["modes", mode, "model"], { provider, model });
  await writeDocument(configPath, document);
}

export async function saveModeReasoning(
  configPath: string,
  mode: ConfigMode,
  reasoning: string,
): Promise<void> {
  const document = await readDocument(configPath);
  ensureMap(document, "modes");
  document.setIn(["modes", mode, "reasoning"], reasoning);
  await writeDocument(configPath, document);
}

export async function appendProviderModel(
  configPath: string,
  provider: string,
  model: string,
): Promise<void> {
  const document = await readDocument(configPath);
  ensureMap(document, "providers");
  if (!document.getIn(["providers", provider])) {
    throw new Error(`unknown provider "${provider}" in ${configPath}`);
  }
  const node = document.getIn(["providers", provider, "models"], true);
  if (isSeq(node)) {
    const values = node.toJSON() as unknown;
    if (!Array.isArray(values) || !values.includes(model)) node.add(model);
  } else {
    document.setIn(["providers", provider, "models"], [model]);
  }
  await writeDocument(configPath, document);
}

export async function replaceProviderModels(
  configPath: string,
  provider: string,
  models: string[],
): Promise<void> {
  const document = await readDocument(configPath);
  ensureMap(document, "providers");
  if (!document.getIn(["providers", provider])) {
    throw new Error(`unknown provider "${provider}" in ${configPath}`);
  }
  const existingNode = document.getIn(["providers", provider, "models"], true);
  const existingValues = isSeq(existingNode) ? ((existingNode.toJSON() as unknown) ?? []) : [];
  const existingModels = Array.isArray(existingValues) ? existingValues : [];
  for (const removed of existingModels) {
    if (!models.includes(removed)) {
      document.deleteIn(["providers", provider, "model_capabilities", removed]);
      clearReferences(document, provider, removed);
    }
  }
  document.setIn(["providers", provider, "models"], models);
  await writeDocument(configPath, document);
}

export async function setProviderEnabled(
  configPath: string,
  provider: string,
  enabled: boolean,
): Promise<void> {
  const document = await readDocument(configPath);
  ensureMap(document, "providers");
  if (!document.getIn(["providers", provider])) {
    throw new Error(`unknown provider "${provider}" in ${configPath}`);
  }
  document.setIn(["providers", provider, "enabled"], enabled);
  await writeDocument(configPath, document);
}

function nodeValue<T>(value: unknown): T | undefined {
  if (value && typeof value === "object" && "toJSON" in value) {
    return (value as { toJSON: () => T }).toJSON();
  }
  return value as T | undefined;
}

function clearReferences(document: Document, provider: string, model?: string): void {
  for (const roleKey of Object.values(ROLE_KEYS)) {
    const role = nodeValue<{ provider?: string; model?: string }>(
      document.getIn(["roles", roleKey]),
    );
    if (role?.provider === provider && (model === undefined || role.model === model)) {
      document.deleteIn(["roles", roleKey]);
    }
  }

  for (const mode of ["plan", "build", "ultrawork"]) {
    const selection = nodeValue<{ provider?: string; model?: string }>(
      document.getIn(["modes", mode, "model"]),
    );
    if (selection?.provider === provider && (model === undefined || selection.model === model)) {
      document.deleteIn(["modes", mode, "model"]);
    }
  }
}

export async function removeProviderModel(
  configPath: string,
  provider: string,
  model: string,
): Promise<void> {
  const document = await readDocument(configPath);
  ensureMap(document, "providers");
  if (!document.getIn(["providers", provider])) {
    throw new Error(`unknown provider "${provider}" in ${configPath}`);
  }
  const node = document.getIn(["providers", provider, "models"], true);
  const values = isSeq(node) ? ((node.toJSON() as unknown) ?? []) : [];
  const models = Array.isArray(values) ? values.filter((entry) => entry !== model) : [];
  document.setIn(["providers", provider, "models"], models);
  document.deleteIn(["providers", provider, "model_capabilities", model]);
  clearReferences(document, provider, model);
  await writeDocument(configPath, document);
}

export async function deleteProviderProfile(
  configPath: string,
  secretsPath: string,
  provider: string,
): Promise<void> {
  const document = await readDocument(configPath);
  document.deleteIn(["providers", provider]);
  clearReferences(document, provider);
  await writeDocument(configPath, document);

  const secrets = await readDocument(secretsPath);
  if (secrets.getIn(["providers", provider]) !== undefined) {
    secrets.deleteIn(["providers", provider]);
    await writeDocument(secretsPath, secrets);
  }
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
