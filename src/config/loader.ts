import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { CatalogModel } from "../provider/model-catalog";
import type { OllamaCapabilities } from "../provider/ollama-introspect";
import { TokenPricingSchema } from "../types/schema";

export const CONFIG_PATH = ".agent/config.yaml";

export type EnvMap = Record<string, string | undefined>;

export class ConfigError extends Error {
  readonly source: string;
  readonly issues: readonly string[];

  constructor(message: string, source: string, issues: readonly string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.source = source;
    this.issues = issues;
  }
}

export const ProviderKindSchema = z.enum(["openai", "anthropic", "openclaude", "ollama", "openrouter"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ModelCapabilitiesSchema = z.object({
  tool_calling: z.boolean().default(true),
  reasoning: z.boolean().default(false),
  vision: z.boolean().default(false),
  context_window: z.number().int().positive().optional(),
  max_output: z.number().int().positive().optional(),
  structured_output: z.boolean().default(false),
  temperature: z.boolean().default(true),
  pdf: z.boolean().default(false),
  parallel_tool_calls: z.boolean().default(true),
  reasoning_efforts: z.array(z.string().min(1)).optional(),
  reasoning_budget_min: z.number().int().positive().optional(),
  reasoning_budget_max: z.number().int().positive().optional(),
});
export type CapabilitySource = "inferred" | "catalog" | "ollama" | "override";
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema> & { source?: CapabilitySource };

export const ModelCapabilitiesPatchSchema = z.object({
  tool_calling: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  vision: z.boolean().optional(),
  context_window: z.number().int().positive().optional(),
  max_output: z.number().int().positive().optional(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  pdf: z.boolean().optional(),
  parallel_tool_calls: z.boolean().optional(),
  reasoning_efforts: z.array(z.string().min(1)).optional(),
  reasoning_budget_min: z.number().int().positive().optional(),
  reasoning_budget_max: z.number().int().positive().optional(),
});
export type ModelCapabilitiesPatch = z.infer<typeof ModelCapabilitiesPatchSchema>;

export const ProviderProfileSchema = z.object({
  kind: ProviderKindSchema,
  base_url: z.url(),
  api_key: z.string().min(1).optional(),
  models: z.array(z.string().min(1)).default([]),
  model_capabilities: z.record(z.string(), ModelCapabilitiesPatchSchema).default({}),
  catalog_provider: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).default({}),
  timeout_ms: z.number().int().positive().default(60_000),
  pricing: TokenPricingSchema.optional(),
  enabled: z.boolean().default(true),
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

export function inferModelCapabilities(kind: ProviderKind, model: string): ModelCapabilities {
  const lower = model.toLowerCase();
  const reasoning = /(^|[^a-z])(o[1-9]|r1|reason|thinking|qwq|magistral|gpt-5|gemini-2\.5|claude)([^a-z]|$)/.test(lower);
  const vision = /(vision|llava|pixtral|minicpm-v|qwen[0-9.]*-vl|gemma3|llama[0-9.]*-vision|claude|gemini|gpt-4o|gpt-4\.1|gpt-5|o[1-9])/.test(lower);
  const largeContext = /(128k|200k|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|o[1-9]|deepseek|qwen3|kimi|glm|minimax)/.test(lower);
  return {
    tool_calling: true,
    reasoning,
    vision,
    context_window: largeContext ? 128_000 : 32_768,
    max_output: kind === "anthropic" ? 8_192 : 4_096,
    structured_output: false,
    temperature: !/^(o[1-9]|gpt-5)/.test(lower),
    pdf: false,
    parallel_tool_calls: true,
  };
}

export interface CapabilityResolutionContext {
  catalogModel?: CatalogModel;
  ollama?: OllamaCapabilities;
}

export function resolveModelCapabilities(
  profile: ProviderProfile,
  model?: string,
  context: CapabilityResolutionContext = {},
): ModelCapabilities {
  const key = model ?? profile.models[0] ?? "";
  const inferred = inferModelCapabilities(profile.kind, key);
  const explicit = key ? profile.model_capabilities[key] : undefined;

  let base: ModelCapabilities = { ...inferred, source: "inferred" };

  if (context.ollama) {
    const ollama = context.ollama;
    base = {
      ...base,
      tool_calling: ollama.toolCalling,
      reasoning: ollama.reasoning,
      vision: ollama.vision,
      context_window: ollama.contextWindow ?? base.context_window,
      source: "ollama",
    };
  } else if (context.catalogModel) {
    const catalog = context.catalogModel;
    const effort = catalog.reasoningOptions.find((option) => option.type === "effort");
    const budget = catalog.reasoningOptions.find(
      (option) => option.type === "budget_tokens" || option.type === "budget",
    );
    base = {
      tool_calling: catalog.toolCall,
      reasoning: catalog.reasoning,
      vision: catalog.attachment && catalog.modalities.input.includes("image"),
      context_window: catalog.limit.context ?? inferred.context_window,
      max_output: catalog.limit.output ?? inferred.max_output,
      structured_output: catalog.structuredOutput,
      temperature: catalog.temperature,
      pdf: catalog.modalities.input.includes("pdf"),
      parallel_tool_calls: inferred.parallel_tool_calls,
      reasoning_efforts: effort?.values,
      reasoning_budget_min: budget?.min,
      reasoning_budget_max: budget?.max,
      source: "catalog",
    };
  }

  if (!explicit) return base;

  return {
    ...base,
    tool_calling: explicit.tool_calling ?? base.tool_calling,
    reasoning: explicit.reasoning ?? base.reasoning,
    vision: explicit.vision ?? base.vision,
    context_window: explicit.context_window ?? base.context_window,
    max_output: explicit.max_output ?? base.max_output,
    structured_output: explicit.structured_output ?? base.structured_output,
    temperature: explicit.temperature ?? base.temperature,
    pdf: explicit.pdf ?? base.pdf,
    parallel_tool_calls: explicit.parallel_tool_calls ?? base.parallel_tool_calls,
    reasoning_efforts: explicit.reasoning_efforts ?? base.reasoning_efforts,
    reasoning_budget_min: explicit.reasoning_budget_min ?? base.reasoning_budget_min,
    reasoning_budget_max: explicit.reasoning_budget_max ?? base.reasoning_budget_max,
    source: "override",
  };
}

export const ModelRefSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const RolesConfigSchema = z.object({
  main_model: ModelRefSchema.optional(),
  fast_model: ModelRefSchema.optional(),
  advisor_model: ModelRefSchema.optional(),
});
export type RolesConfig = z.infer<typeof RolesConfigSchema>;

export const InboundServerConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8787),
  api_key: z.string().min(1).optional(),
  enable_openapi: z.boolean().default(true),
  enable_openclaude: z.boolean().default(false),
});
export type InboundServerConfig = z.infer<typeof InboundServerConfigSchema>;

export const LspServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  root_markers: z.array(z.string().min(1)).default([]),
  env: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
});
export type LspServerConfig = z.infer<typeof LspServerConfigSchema>;

export const McpServerConfigSchema = z
  .object({
    transport: z.enum(["stdio", "http", "sse"]).default("stdio"),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    url: z.url().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    env: z.record(z.string(), z.string()).default({}),
    enabled: z.boolean().default(true),
  })
  .refine((value) => (value.transport === "stdio" ? value.command !== undefined : value.url !== undefined), {
    message: "stdio transport requires command, http and sse transports require url",
  });
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const FilesystemPermissionsSchema = z.object({
  read: z.array(z.string().min(1)).default(["**/*"]),
  write: z.array(z.string().min(1)).default([]),
  deny: z.array(z.string().min(1)).default([".git/**", ".env", ".env.*"]),
});
export type FilesystemPermissions = z.infer<typeof FilesystemPermissionsSchema>;

export const NetworkPermissionsSchema = z.object({
  allow: z.array(z.string().min(1)).default([]),
  deny: z.array(z.string().min(1)).default([]),
});
export type NetworkPermissions = z.infer<typeof NetworkPermissionsSchema>;

export const CommandPermissionsSchema = z.object({
  allow: z.array(z.string().min(1)).default([]),
  deny: z.array(z.string().min(1)).default([]),
  escalate: z.enum(["allow", "ask", "deny"]).default("ask"),
});
export type CommandPermissions = z.infer<typeof CommandPermissionsSchema>;

export const HookCommandSchema = z.object({
  match: z.string().min(1).default("*"),
  command: z.string().min(1),
  timeout_ms: z.number().int().positive().default(30_000),
});
export type HookCommand = z.infer<typeof HookCommandSchema>;

export const HooksConfigSchema = z.object({
  pre_tool_use: z.array(HookCommandSchema).default([]),
  post_tool_use: z.array(HookCommandSchema).default([]),
  on_stop: z.array(HookCommandSchema).default([]),
});
export type HooksConfig = z.infer<typeof HooksConfigSchema>;

export const SandboxPermissionsSchema = z.object({
  filesystem: FilesystemPermissionsSchema.prefault({}),
  network: NetworkPermissionsSchema.prefault({}),
  commands: CommandPermissionsSchema.prefault({}),
});
export type SandboxPermissions = z.infer<typeof SandboxPermissionsSchema>;

export const SandboxConfigSchema = z.object({
  permissions: SandboxPermissionsSchema.prefault({}),
});
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

export const CompactionConfigSchema = z.object({
  auto: z.boolean().default(true),
  keep_tokens: z.number().int().positive().default(15_000),
  buffer_ratio: z.number().min(0).max(0.9).default(0.1),
  buffer_tokens: z.number().int().positive().optional(),
});
export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;

export const WebSearchConfigSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.enum(["tavily", "brave", "exa", "duckduckgo", "random"]).default("random"),
});
export type WebSearchConfig = z.infer<typeof WebSearchConfigSchema>;

export const WebFetchConfigSchema = z.object({
  enabled: z.boolean().default(true),
});
export type WebFetchConfig = z.infer<typeof WebFetchConfigSchema>;

export const PromptConfigSchema = z.object({
  style: z.enum(["auto", "full", "compact"]).default("auto"),
});
export type PromptConfig = z.infer<typeof PromptConfigSchema>;

export const ModeModelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type ModeModel = z.infer<typeof ModeModelSchema>;

export const ModeSettingsSchema = z.object({
  model: ModeModelSchema.optional(),
  reasoning: z.string().min(1).optional(),
});
export type ModeSettings = z.infer<typeof ModeSettingsSchema>;

export const ModesConfigSchema = z.object({
  plan: ModeSettingsSchema.prefault({}),
  build: ModeSettingsSchema.prefault({}),
  ultrawork: ModeSettingsSchema.prefault({}),
});
export type ModesConfig = z.infer<typeof ModesConfigSchema>;

export const AppConfigSchema = z.object({
  version: z.number().int().positive().default(1),
  providers: z.record(z.string().min(1), ProviderProfileSchema).default({}),
  roles: RolesConfigSchema.default({}),
  modes: ModesConfigSchema.prefault({}),
  inbound_server: InboundServerConfigSchema.prefault({}),
  lsp: z
    .object({
      servers: z.record(z.string().min(1), LspServerConfigSchema).default({}),
    })
    .prefault({}),
  mcp: z
    .object({
      servers: z.record(z.string().min(1), McpServerConfigSchema).default({}),
    })
    .prefault({}),
  hooks: HooksConfigSchema.prefault({}),
  sandbox: SandboxConfigSchema.prefault({}),
  compaction: CompactionConfigSchema.prefault({}),
  websearch: WebSearchConfigSchema.prefault({}),
  webfetch: WebFetchConfigSchema.prefault({}),
  prompt: PromptConfigSchema.prefault({}),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

const ProviderSecretSchema = z.object({
  api_key: z.string().min(1).optional(),
});

export const SecretsConfigSchema = z.object({
  providers: z.record(z.string().min(1), ProviderSecretSchema).default({}),
});
export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;

const PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const EXACT_PLACEHOLDER_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export function substituteEnvVars<T>(value: T, env: EnvMap = process.env): T {
  return substituteValue(value, env) as T;
}

function substituteValue(value: unknown, env: EnvMap): unknown {
  if (typeof value === "string") return substituteString(value, env);
  if (Array.isArray(value)) return value.map((item) => substituteValue(item, env) ?? "");
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const substituted = substituteValue(entry, env);
      if (substituted !== undefined) result[key] = substituted;
    }
    return result;
  }
  return value;
}

function substituteString(value: string, env: EnvMap): string | undefined {
  const exact = EXACT_PLACEHOLDER_PATTERN.exec(value);
  if (exact) {
    const resolved = env[exact[1]];
    return resolved ? resolved : undefined;
  }
  return value.replace(PLACEHOLDER_PATTERN, (_match, name: string) => env[name] ?? "");
}

export function parseConfig(raw: unknown, source: string = "<inline>"): AppConfig {
  const candidate = raw === null || raw === undefined ? {} : raw;
  const result = AppConfigSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid agent config in ${source}`, source, issues);
  }
  return result.data;
}

export function parseConfigText(text: string, source: string, env: EnvMap = process.env): AppConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Failed to parse YAML in ${source}: ${detail}`, source);
  }
  return parseConfig(substituteEnvVars(raw, env), source);
}

export function defaultConfig(): AppConfig {
  return AppConfigSchema.parse({});
}

export async function loadSecrets(path: string): Promise<SecretsConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return SecretsConfigSchema.parse({});
  try {
    const raw: unknown = parseYaml(await file.text());
    const result = SecretsConfigSchema.safeParse(raw ?? {});
    return result.success ? result.data : SecretsConfigSchema.parse({});
  } catch {
    return SecretsConfigSchema.parse({});
  }
}

export async function loadConfig(
  path: string = CONFIG_PATH,
  env: EnvMap = process.env,
  options: { secretsPath?: string } = {},
): Promise<AppConfig> {
  const file = Bun.file(path);
  const config = (await file.exists()) ? parseConfigText(await file.text(), path, env) : defaultConfig();
  if (!options.secretsPath) return config;

  const secrets = await loadSecrets(options.secretsPath);
  for (const [name, secret] of Object.entries(secrets.providers)) {
    const profile = config.providers[name];
    if (profile && !profile.api_key && secret.api_key) {
      profile.api_key = secret.api_key;
    }
  }
  return config;
}
