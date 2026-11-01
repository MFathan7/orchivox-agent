import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

import { currentMode, currentTurnContext } from "../agent/turn-context";
import { planDirectory } from "./plan-directory";
import { DEFAULT_PLAN_FILE, userRequestedPlanPath } from "./plan-path";
import type { AgentTool } from "./registry";

export const PLAN_FILE_RELATIVE_PATH = DEFAULT_PLAN_FILE;

const PLAN_FILE_NAME = /^PLAN[A-Za-z0-9._-]*\.md$/i;

interface PlanTarget {
  relativePath: string;
  absolutePath: string;
}

function insideRoot(realRoot: string, path: string): boolean {
  const rel = relative(realRoot, path);
  return (
    rel !== ".." &&
    !rel.startsWith("../") &&
    !rel.startsWith("..\\") &&
    !isAbsolute(rel)
  );
}

async function nearestExistingPath(path: string): Promise<string | undefined> {
  let current = path;
  while (true) {
    const real = await realpath(current).catch(() => undefined);
    if (real) return real;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function resolvePlanTarget(directory: string, requested?: string): Promise<PlanTarget | string> {
  const raw = (requested ?? PLAN_FILE_RELATIVE_PATH).trim();
  if (raw.length === 0) return "plan path cannot be empty";
  if (!raw.toLowerCase().endsWith(".md")) return "plan file must end with .md";
  if (!PLAN_FILE_NAME.test(basename(raw))) return "plan file name must match PLAN*.md";

  const root = resolve(directory);
  const absolutePath = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const relativePath = relative(root, absolutePath);
  if (!insideRoot(root, absolutePath)) {
    return "plan path must stay inside the plan directory";
  }

  const realRoot = await realpath(root).catch(() => root);
  const existingParent = await nearestExistingPath(dirname(absolutePath));
  if (existingParent && !insideRoot(realRoot, existingParent)) {
    return "plan path must stay inside the plan directory";
  }
  const existingTarget = await realpath(absolutePath).catch(() => undefined);
  if (existingTarget && !insideRoot(realRoot, existingTarget)) {
    return "plan path must stay inside the plan directory";
  }
  return { relativePath, absolutePath };
}

/**
 * Plan mode is read-only except for a plan file in the active project. The
 * model must only call this tool when the user explicitly asks to save a plan.
 * The user's path wins. Without a named path, the default is PLAN.md at the
 * project root.
 */
export function createWritePlanTool(options: {
  repoRoot: string;
  relativePath?: string;
  directory?: string;
}): AgentTool {
  const defaultPath = options.relativePath ?? PLAN_FILE_RELATIVE_PATH;

  return {
    name: "write_plan",
    description:
      "Write a plan file in the global Orchivox plan directory. Use only when the user explicitly asks to save a plan. By default write PLAN.md. When the user names a path, use it exactly. The path must be a PLAN*.md file inside the plan directory, such as PLAN.md or PLAN9.md. Set append=true to add a section.",
    parameters: z.object({
      content: z.string().min(1),
      append: z.boolean().default(false),
      path: z.string().min(1).optional(),
    }),
    readOnly: false,
    async execute(args) {
      if (currentMode() !== "plan") {
        return `write_plan is only available in plan mode.`;
      }
      const request = args as { content: string; append: boolean; path?: string };
      const root = options.directory ?? planDirectory();
      await mkdir(root, { recursive: true });
      const requested = request.path?.trim();
      let targetPath = defaultPath;
      let fallbackNote = "";

      if (requested) {
        const validated = await resolvePlanTarget(root, requested);
        if (typeof validated === "string") {
          return `plan write rejected: ${validated}`;
        }
        if (userRequestedPlanPath(currentTurnContext()?.userText, validated.relativePath)) {
          targetPath = validated.relativePath;
        } else if (validated.relativePath !== defaultPath) {
          fallbackNote = ` (used ${defaultPath} because the user did not request ${validated.relativePath})`;
        }
      }

      const target = await resolvePlanTarget(root, targetPath);
      if (typeof target === "string") {
        return `plan write rejected: ${target}`;
      }
      await mkdir(dirname(target.absolutePath), { recursive: true });
      if (request.append) {
        const existing = await readFile(target.absolutePath, "utf8").catch(() => "");
        const next =
          existing.trim().length > 0
            ? `${existing.trimEnd()}\n\n${request.content}`
            : request.content;
        await writeFile(target.absolutePath, next, "utf8");
      } else {
        await writeFile(target.absolutePath, request.content, "utf8");
      }
      return `wrote ${request.content.length} characters to ${target.relativePath}${request.append ? " (appended)" : ""}${fallbackNote}`;
    },
  };
}
