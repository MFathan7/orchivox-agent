import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import type { AgentMode } from "../types/schema";
import { planDirectory } from "./plan-directory";

export const DEFAULT_PLAN_FILE = "PLAN.md";

const PLAN_FILE_NAME = /^PLAN[A-Za-z0-9._-]*\.md$/i;
const AGENT_DIRECTORY = /(^|[\\/])\.agent([\\/]|$)/i;

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isPlanFileName(path: string): boolean {
  return PLAN_FILE_NAME.test(basename(path));
}

export function isAgentDirectoryPath(path: string): boolean {
  return AGENT_DIRECTORY.test(path);
}

export function relativeToRoot(root: string | undefined, path: string): string {
  if (!root || !isAbsolute(path)) return normalizePath(path);
  return normalizePath(relative(root, path));
}

/**
 * A custom plan path is allowed only when the user named it. Naming the parent
 * folder and the PLAN*.md filename is enough, for example "save it in docs as
 * PLAN9.md". A bare path that the model invented is not enough.
 */
export function userRequestedPlanPath(userText: string | undefined, path: string): boolean {
  if (!userText) return false;
  const text = normalizePath(userText).toLowerCase();
  const target = normalizePath(path).toLowerCase();
  if (target.length === 0) return false;
  if (text.includes(target)) return true;

  const name = basename(target);
  if (!text.includes(name)) return false;
  const parent = dirname(target);
  if (parent === "." || parent === "" || parent === "/") return true;
  return text.includes(parent);
}

/**
 * Plan mode keeps plans in the user's global plan directory. Build and
 * Ultrawork keep plans in the active project root.
 */
export function defaultPlanPath(root: string, mode: AgentMode = "build"): string {
  return mode === "plan"
    ? resolve(planDirectory(), DEFAULT_PLAN_FILE)
    : resolve(root, DEFAULT_PLAN_FILE);
}

/**
 * `create_file` stays general. A PLAN*.md file the user did not name is
 * redirected to the mode's canonical plan location. `.agent` is reserved for
 * configuration, so a plan file is never written there even when the model
 * names that path.
 */
export function redirectPlanPath(input: {
  path: string;
  userText?: string;
  root?: string;
  mode?: AgentMode;
  defaultPath?: string;
}): { path: string; redirectedFrom?: string } {
  if (!isPlanFileName(input.path)) {
    return { path: input.path };
  }
  const root = input.root ?? globalThis.process.cwd();
  const mode = input.mode ?? "build";
  const target =
    input.defaultPath ?? defaultPlanPath(root, mode);
  const absoluteInput = resolve(root, input.path);
  const agentPath = isAgentDirectoryPath(input.path);
  if (
    mode !== "plan" &&
    !agentPath &&
    userRequestedPlanPath(input.userText, relativeToRoot(root, input.path))
  ) {
    return { path: input.path };
  }
  if (absoluteInput === resolve(target)) {
    return { path: target };
  }
  return {
    path: target,
    redirectedFrom: input.path,
  };
}
