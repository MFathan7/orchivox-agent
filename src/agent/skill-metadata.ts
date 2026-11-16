import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { SkillDocument } from "./skills";

export interface SkillMetadataNotice {
  path: string;
  severity: "warning" | "error";
  message: string;
}

export interface SkillDependency {
  type: string;
  value: string;
  description?: string;
  transport?: string;
  url?: string;
}

const Names = z.array(z.string().trim().min(1));
export const SkillRequirementsSchema = z.object({
  tools: Names.optional(),
  executables: Names.optional(),
  mcp_servers: Names.optional(),
}).passthrough();

const InterfaceSchema = z.object({
  display_name: z.string().optional(), short_description: z.string().optional(),
  icon_small: z.string().optional(), icon_large: z.string().optional(),
  brand_color: z.string().optional(), default_prompt: z.string().optional(),
  default_prompts: Names.optional(),
}).passthrough();
export type SkillInterfaceMetadata = z.infer<typeof InterfaceSchema>;

const ToolDependencySchema = z.object({
  type: z.string().trim().min(1), value: z.string().trim().min(1),
  description: z.string().optional(), transport: z.string().optional(), url: z.string().url().optional(),
}).passthrough();
const SidecarSchema = z.object({
  interface: InterfaceSchema.optional(),
  policy: z.object({ allow_implicit_invocation: z.boolean().optional() }).passthrough().optional(),
  dependencies: z.union([
    z.object({ tools: z.array(ToolDependencySchema).optional() }).passthrough(),
    z.array(z.never()).max(0).transform(() => ({} as { tools?: z.infer<typeof ToolDependencySchema>[] })),
  ]).optional(),
}).passthrough();

export function unsupportedMetadata(
  value: Record<string, unknown>, keys: readonly string[], path: string, prefix = "",
): SkillMetadataNotice[] {
  return Object.keys(value).filter((key) => !keys.includes(key)).map((key) => ({
    path, severity: "warning",
    message: `Unsupported metadata field: ${prefix}${key}. It has no runtime effect.`,
  }));
}

export async function loadSkillSidecar(document: SkillDocument): Promise<SkillDocument> {
  if (basename(document.path) !== "SKILL.md") return document;
  const path = join(dirname(document.path), "agents", "openai.yaml");
  try { await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return document;
    return metadataFailure(document, path, error);
  }
  try {
    const data = SidecarSchema.parse(parseYaml(await readFile(path, "utf8")));
    const notices = [...(document.metadataNotices ?? []), ...unsupportedMetadata(data, Object.keys(SidecarSchema.shape), path)];
    if (data.policy) notices.push(...unsupportedMetadata(data.policy, ["allow_implicit_invocation"], path, "policy."));
    if (data.interface) notices.push(...unsupportedMetadata(data.interface, Object.keys(InterfaceSchema.shape), path, "interface."));
    if (data.dependencies) notices.push(...unsupportedMetadata(data.dependencies, ["tools"], path, "dependencies."));
    for (const [index, dependency] of (data.dependencies?.tools ?? []).entries()) {
      notices.push(...unsupportedMetadata(dependency, Object.keys(ToolDependencySchema.shape), path, `dependencies.tools[${index}].`));
    }
    const implicit = data.policy?.allow_implicit_invocation;
    if ((implicit === false && document.invocationPreference === true) ||
      (implicit === true && document.autoinvoke === false)) {
      notices.push({ path, severity: "warning", message: "Invocation settings disagree. The explicit-only setting takes precedence." });
    }
    const dependencies = (data.dependencies?.tools ?? []).map(({ type, value, description, transport, url }) => ({ type, value, description, transport, url }));
    return {
      ...document, sidecarPath: path, interface: data.interface,
      autoinvoke: document.autoinvoke !== false && implicit !== false,
      dependencies: [...(document.dependencies ?? []), ...dependencies], metadataNotices: notices,
    };
  } catch (error) { return metadataFailure(document, path, error); }
}

function metadataFailure(document: SkillDocument, path: string, error: unknown): SkillDocument {
  const message = `Cannot read skill sidecar metadata: ${error instanceof Error ? error.message : String(error)}`;
  return {
    ...document, sidecarPath: path, metadataError: message,
    metadataNotices: [...(document.metadataNotices ?? []), { path, severity: "error", message }],
  };
}

export function skillEnabled(document: SkillDocument): boolean {
  return document.enabled !== false && !document.metadataError;
}

export function skillInvocationLabel(document: SkillDocument): string {
  if (document.enabled === false) return "disabled";
  if (document.metadataError) return "metadata error";
  if (document.hidden) return "hidden; explicit only";
  return document.autoinvoke === false ? "explicit only" : "explicit or contextual";
}
