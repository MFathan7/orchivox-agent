import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type ConfigSource = "flag" | "env" | "project" | "global" | "default";

export interface ResolvedConfigPaths {
  configPath: string;
  secretsPath: string;
  configSource: ConfigSource;
  secretsSource: ConfigSource;
  fallbackSecretsPaths: string[];
}

export interface ResolveConfigPathsOptions {
  cwd?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  configFlag?: string;
  secretsFlag?: string;
  fileExists?: (path: string) => Promise<boolean>;
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

function absolutePath(value: string, cwd: string, home: string): string {
  const expanded = expandHome(value, home);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    return await Bun.file(path).exists();
  } catch {
    return false;
  }
}

async function requireFile(
  path: string,
  label: string,
  fileExists: (path: string) => Promise<boolean>,
): Promise<void> {
  if (!(await fileExists(path))) {
    throw new Error(`${label} not found: ${path}`);
  }
}

export async function resolveConfigPaths(
  options: ResolveConfigPathsOptions = {},
): Promise<ResolvedConfigPaths> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? defaultFileExists;

  const projectConfig = join(cwd, ".agent", "config.yaml");
  const projectSecrets = join(cwd, ".agent", "secrets.yaml");
  const globalConfig = join(home, ".orchivox", "config.yaml");
  const globalSecrets = join(home, ".orchivox", "secrets.yaml");

  let configPath: string;
  let configSource: ConfigSource;

  if (options.configFlag?.trim()) {
    configPath = absolutePath(options.configFlag.trim(), cwd, home);
    await requireFile(configPath, "Config file", fileExists);
    configSource = "flag";
  } else if (env.ORCHIVOX_CONFIG?.trim()) {
    configPath = absolutePath(env.ORCHIVOX_CONFIG.trim(), cwd, home);
    await requireFile(configPath, "Config file", fileExists);
    configSource = "env";
  } else if (await fileExists(projectConfig)) {
    configPath = projectConfig;
    configSource = "project";
  } else if (await fileExists(globalConfig)) {
    configPath = globalConfig;
    configSource = "global";
  } else {
    configPath = projectConfig;
    configSource = "default";
  }

  let secretsPath: string;
  let secretsSource: ConfigSource;

  if (options.secretsFlag?.trim()) {
    secretsPath = absolutePath(options.secretsFlag.trim(), cwd, home);
    await requireFile(secretsPath, "Secrets file", fileExists);
    secretsSource = "flag";
  } else if (env.ORCHIVOX_SECRETS?.trim()) {
    secretsPath = absolutePath(env.ORCHIVOX_SECRETS.trim(), cwd, home);
    await requireFile(secretsPath, "Secrets file", fileExists);
    secretsSource = "env";
  } else if (configSource === "global") {
    secretsPath = globalSecrets;
    secretsSource = "global";
  } else if (configSource === "flag" || configSource === "env") {
    secretsPath = join(dirname(configPath), "secrets.yaml");
    secretsSource = configSource;
  } else {
    secretsPath = projectSecrets;
    secretsSource = configSource;
  }

  const fallbackSecretsPaths: string[] = [];
  if (secretsPath !== globalSecrets && (await fileExists(globalSecrets))) {
    fallbackSecretsPaths.push(globalSecrets);
  }

  return {
    configPath,
    secretsPath,
    configSource,
    secretsSource,
    fallbackSecretsPaths,
  };
}
