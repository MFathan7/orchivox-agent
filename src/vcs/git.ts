import { stat } from "node:fs/promises";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunGitOptions {
  env?: Record<string, string>;
  allowFailure?: boolean;
}

export async function runGit(repoRoot: string, args: string[], options: RunGitOptions = {}): Promise<GitResult> {
  const proc = Bun.spawn(["git", "-C", repoRoot, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...collectEnv(), ...options.env },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  return { stdout, stderr, exitCode };
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function collectEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(globalThis.process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
