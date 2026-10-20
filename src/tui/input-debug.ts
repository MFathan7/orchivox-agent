import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function isInputDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.ORCHIVOX_INPUT_DEBUG;
  return value === "1" || value === "true";
}

export function writeInputDebug(
  data: string,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const directory = join(homedir(), ".cache", "orchivox");
    mkdirSync(directory, { recursive: true });
    appendFileSync(
      join(directory, "input-debug.log"),
      `${now.toISOString()} term=${env.TERM ?? "unknown"} data=${JSON.stringify(data)}\n`,
    );
  } catch {
    // Input diagnostics must never block typing.
  }
}
