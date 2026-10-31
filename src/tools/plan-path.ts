import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

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

export function defaultPlanPath(root: string): string {
  return resolve(root, DEFAULT_PLAN_FILE);
}

/**
 * `create_file` stays general. This guard only catches a PLAN*.md file placed
 * under .agent when the user did not ask for that path. Every other file keeps
 * the path the model requested.
 */
export function redirectPlanPath(input: {
  path: string;
  userText?: string;
  root?: string;
  defaultPath?: string;
}): { path: string; redirectedFrom?: string } {
  if (!isPlanFileName(input.path) || !isAgentDirectoryPath(input.path)) {
    return { path: input.path };
  }
  const root = input.root ?? globalThis.process.cwd();
  if (userRequestedPlanPath(input.userText, relativeToRoot(root, input.path))) {
    return { path: input.path };
  }
  return {
    path: input.defaultPath ?? defaultPlanPath(root),
    redirectedFrom: input.path,
  };
}
