import { homedir } from "node:os";
import { join } from "node:path";

/** Plan files live under the user's global Orchivox plan directory. */
export function planDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORCHIVOX_PLAN_HOME?.trim() || join(homedir(), ".orchivox", "plan");
}
