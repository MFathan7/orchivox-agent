import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const MARKER_START = "# >>> orchivox installer >>>";
const MARKER_END = "# <<< orchivox installer <<<";

export interface ShellPathResult {
  file: string;
  changed: boolean;
  backup?: string;
  line: string;
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME?.trim() || homedir();
}

export function shellConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = homeDir(env);
  const shell = basename(env.SHELL ?? "");
  if (shell === "fish") return join(home, ".config", "fish", "config.fish");
  if (shell === "zsh") return join(home, ".zshrc");
  if (shell === "bash") return join(home, ".bashrc");
  return join(home, ".profile");
}

export function pathExpression(binDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = homeDir(env);
  const relativeToHome = relative(home, binDir);
  if (relativeToHome && !relativeToHome.startsWith("..") && !relativeToHome.startsWith("/")) {
    return `$HOME/${relativeToHome.replace(/\\/g, "/")}`;
  }
  return binDir.replace(/"/g, '\\"');
}

export function shellPathLine(binDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const shell = basename(env.SHELL ?? "");
  const expression = pathExpression(binDir, env);
  if (shell === "fish") return `fish_add_path ${expression}`;
  return `export PATH="${expression}:$PATH"`;
}

export function pathHint(binDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return shellPathLine(binDir, env);
}

export function addToShellPath(options: {
  binDir: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  now?: Date;
}): ShellPathResult {
  const env = options.env ?? process.env;
  const file = options.configPath ?? shellConfigPath(env);
  const line = shellPathLine(options.binDir, env);
  const block = `${MARKER_START}\n${line}\n${MARKER_END}`;
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const markerPattern = /# >>> orchivox installer >>>[\s\S]*?# <<< orchivox installer <<<\n?/;

  if (markerPattern.test(existing)) {
    const next = existing.replace(markerPattern, `${block}\n`);
    if (next === existing) {
      return { file, changed: false, line };
    }
    const backup = backupFile(file, options.now);
    writeFileSync(file, next, { mode: statMode(file) });
    return { file, changed: true, line, backup };
  }

  mkdirSync(dirname(file), { recursive: true });
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const separator = existing.length > 0 ? "\n" : "";
  const backup = existsSync(file) ? backupFile(file, options.now) : undefined;
  writeFileSync(file, `${existing}${prefix}${separator}${block}\n`, {
    mode: statMode(file),
  });
  return { file, changed: true, line, backup };
}

function backupFile(file: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const backup = `${file}.bak-${stamp}`;
  copyFileSync(file, backup);
  return backup;
}

function statMode(file: string): number {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return 0o644;
  }
}

export function isCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(lookup, [command], {
      env,
      stdio: "ignore",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * `where` can find an npm .ps1 shim that a restricted PowerShell still
 * refuses to run. Treat a result as usable only when at least one match is
 * not a .ps1 file.
 */
export function isUsableWindowsCommandOutput(output: string): boolean {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => !line.toLowerCase().endsWith(".ps1"));
}

export function isCommandUsableOnWindows(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const result = spawnSync("where", [command], {
      env,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) return false;
    return isUsableWindowsCommandOutput(result.stdout ?? "");
  } catch {
    return false;
  }
}

export interface WindowsPathResult {
  changed: boolean;
  pathOnPath: boolean;
  detail: string;
  manual?: string;
}

export interface SpawnSyncResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

export type SpawnSyncRunner = (
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    encoding: "utf8";
    windowsHide?: boolean;
    timeout?: number;
  },
) => SpawnSyncResult;

const defaultRunner: SpawnSyncRunner = (command, args, options) => {
  const result = spawnSync(command, args, options);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
};

function normalizeWindowsPath(value: string): string {
  return value
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\//g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

function expandWindowsEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    const key = Object.keys(env).find((entry) => entry.toLowerCase() === name.toLowerCase());
    return key ? env[key] ?? match : match;
  });
}

function readWindowsUserPath(
  env: NodeJS.ProcessEnv,
  runner: SpawnSyncRunner,
): { value: string; error?: string } {
  const result = runner("reg", ["query", "HKCU\\Environment", "/v", "Path"], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status === 0) {
    const line = (result.stdout ?? "")
      .split(/\r?\n/)
      .find((entry) => /\bPath\b/i.test(entry));
    const match = line?.match(/\bPath\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i);
    return { value: match?.[1]?.trim() ?? "" };
  }

  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  if (/unable to find|not find/i.test(output)) {
    return { value: "" };
  }
  return {
    value: "",
    error: output || result.error?.message || "Could not read the Windows user PATH.",
  };
}

/**
 * Adds the install directory to the per-user PATH with reg.exe. It never
 * throws: a blocked or missing command returns a manual fallback so the
 * installation itself can still succeed.
 */
export function configureWindowsPath(
  binDir: string,
  env: NodeJS.ProcessEnv = process.env,
  runner: SpawnSyncRunner = defaultRunner,
): WindowsPathResult {
  const normalized = normalizeWindowsPath(binDir);
  const current = readWindowsUserPath(env, runner);
  if (current.error) {
    return {
      changed: false,
      pathOnPath: false,
      detail: current.error,
      manual: binDir,
    };
  }
  const parts = current.value.split(";").map((part) => part.trim()).filter(Boolean);
  const present = parts.some(
    (part) => normalizeWindowsPath(expandWindowsEnv(part, env)) === normalized,
  );
  if (present) {
    return { changed: false, pathOnPath: true, detail: "already present" };
  }

  const next = [...parts, binDir].join(";");
  const result = runner(
    "reg",
    ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", next, "/f"],
    { env, encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  if (result.status !== 0) {
    const detail = (result.stderr ?? result.stdout ?? result.error?.message ?? "reg add failed").trim();
    return { changed: false, pathOnPath: false, detail, manual: binDir };
  }
  return { changed: true, pathOnPath: true, detail: "added" };
}
