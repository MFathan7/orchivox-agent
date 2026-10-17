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

export async function ensureAgentExcluded(repoRoot: string): Promise<void> {
  const { stdout } = await runGit(repoRoot, ["rev-parse", "--git-path", "info/exclude"]);
  const rawPath = stdout.trim();
  const excludePath = rawPath.startsWith("/") ? rawPath : `${repoRoot}/${rawPath}`;
  const file = Bun.file(excludePath);
  const current = (await file.exists()) ? await file.text() : "";
  const entries = new Set(current.split("\n").map((line) => line.trim()));
  if (entries.has(".agent/") || entries.has(".agent")) return;
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  await Bun.write(excludePath, `${current}${prefix}.agent/\n`);
}

function collectEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(globalThis.process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
