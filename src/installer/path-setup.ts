import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

import { InstallerError } from "./types";

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
    return `$HOME/${relativeToHome}`;
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

export function addToWindowsUserPath(
  binDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { changed: boolean; detail: string } {
  const escaped = binDir.replace(/'/g, "''");
  const script = [
    `$dir = '${escaped}'`,
    "$path = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$parts = @($path -split ';' | Where-Object { $_ -ne '' })",
    "if ($parts -contains $dir) { Write-Output 'already'; exit 0 }",
    "$next = (@($parts) + $dir) -join ';'",
    "[Environment]::SetEnvironmentVariable('Path', $next, 'User')",
    "Write-Output 'added'",
  ].join("; ");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { env, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new InstallerError(
      "path_update_failed",
      `Could not update the Windows user PATH: ${result.stderr?.trim() || result.stdout?.trim() || "unknown error"}`,
    );
  }
  return {
    changed: (result.stdout ?? "").includes("added"),
    detail: (result.stdout ?? "").trim(),
  };
}
