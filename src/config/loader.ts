import { parse as parseYaml } from "yaml";
import { z } from "zod";

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

export const ProviderProfileSchema = z.object({
  kind: ProviderKindSchema,
  base_url: z.url(),
  api_key: z.string().min(1).optional(),
  models: z.array(z.string().min(1)).default([]),
  headers: z.record(z.string(), z.string()).default({}),
  timeout_ms: z.number().int().positive().default(60_000),
  pricing: TokenPricingSchema.optional(),
  enabled: z.boolean().default(true),
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

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

export const AppConfigSchema = z.object({
  version: z.number().int().positive().default(1),
  providers: z.record(z.string().min(1), ProviderProfileSchema).default({}),
  roles: RolesConfigSchema.default({}),
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
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

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

export async function loadConfig(path: string = CONFIG_PATH, env: EnvMap = process.env): Promise<AppConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return defaultConfig();
  return parseConfigText(await file.text(), path, env);
}
