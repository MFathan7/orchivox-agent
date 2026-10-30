import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

import { currentMode } from "../agent/turn-context";
import type { AgentTool } from "./registry";

export const PLAN_FILE_RELATIVE_PATH = "PLAN.md";

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

async function resolvePlanTarget(repoRoot: string, requested?: string): Promise<PlanTarget | string> {
  const raw = (requested ?? PLAN_FILE_RELATIVE_PATH).trim();
  if (raw.length === 0) return "plan path cannot be empty";
  if (isAbsolute(raw)) return "plan path must be relative to the active project";
  if (!raw.toLowerCase().endsWith(".md")) return "plan file must end with .md";
  if (!PLAN_FILE_NAME.test(basename(raw))) return "plan file name must match PLAN*.md";

  const root = resolve(repoRoot);
  const absolutePath = resolve(root, raw);
  const relativePath = relative(root, absolutePath);
  if (!insideRoot(root, absolutePath)) {
    return "plan path must stay inside the active project";
  }

  const realRoot = await realpath(root).catch(() => root);
  const existingParent = await nearestExistingPath(dirname(absolutePath));
  if (existingParent && !insideRoot(realRoot, existingParent)) {
    return "plan path must stay inside the active project";
  }
  const existingTarget = await realpath(absolutePath).catch(() => undefined);
  if (existingTarget && !insideRoot(realRoot, existingTarget)) {
    return "plan path must stay inside the active project";
  }
  return { relativePath, absolutePath };
}

/**
 * Plan mode is read-only except for a plan file in the active project. The
 * model must only call this tool when the user explicitly asks to save a plan.
 */
export function createWritePlanTool(options: {
  repoRoot: string;
  relativePath?: string;
}): AgentTool {
  const defaultPath = options.relativePath ?? PLAN_FILE_RELATIVE_PATH;

  return {
    name: "write_plan",
    description:
      "Write a plan file in the active project. Use only when the user explicitly asks to save a plan. The path must be a PLAN*.md file inside the project, such as PLAN.md or PLAN1.md. Set append=true to add a section.",
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
      const target = await resolvePlanTarget(options.repoRoot, request.path ?? defaultPath);
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
      return `wrote ${request.content.length} characters to ${target.relativePath}${request.append ? " (appended)" : ""}`;
    },
  };
}
