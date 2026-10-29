import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import { currentMode } from "../agent/turn-context";
import type { AgentTool } from "./registry";

export const PLAN_FILE_RELATIVE_PATH = ".agent/plan.md";

/**
 * Plan mode is read-only except for one file. The tool has no path argument, so
 * the model cannot point it at anything else in the repository.
 */
export function createWritePlanTool(options: { repoRoot: string; relativePath?: string }): AgentTool {
  const relativePath = options.relativePath ?? PLAN_FILE_RELATIVE_PATH;
  const target = resolve(options.repoRoot, relativePath);

  return {
    name: "write_plan",
    description:
      "Write the implementation plan to .agent/plan.md. Set append=true to add a section. Keep the chat answer short and point the user to this file.",
    parameters: z.object({
      content: z.string().min(1),
      append: z.boolean().default(false),
    }),
    readOnly: false,
    async execute(args) {
      if (currentMode() !== "plan") {
        return `write_plan is only available in plan mode.`;
      }
      const request = args as { content: string; append: boolean };
      await mkdir(dirname(target), { recursive: true });
      if (request.append) {
        const existing = await readFile(target, "utf8").catch(() => "");
        const next =
          existing.trim().length > 0
            ? `${existing.trimEnd()}\n\n${request.content}`
            : request.content;
        await writeFile(target, next, "utf8");
      } else {
        await writeFile(target, request.content, "utf8");
      }
      return `wrote ${request.content.length} characters to ${relativePath}${request.append ? " (appended)" : ""}`;
    },
  };
}
