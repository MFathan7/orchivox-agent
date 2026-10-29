import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

export interface ProjectContext {
  name: string;
  aliases: string[];
  description: string;
  summary: string;
  instructionPaths: string[];
}

const PROJECT_DIRECTIVE_PATTERN = /Project directive:\s*`?([^`\n]+)`?/i;
export function findProjectDirective(content: string): string | undefined {
  const match = PROJECT_DIRECTIVE_PATTERN.exec(content);
  if (!match) return undefined;
  const value = match[1]
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.,;:]+$/, "")
    .trim();
  return value.length > 0 ? value : undefined;
}

export async function loadProjectContext(repoRoot: string): Promise<ProjectContext> {
  const root = resolve(repoRoot);
  const packageJson = await readJson(join(root, "package.json"));
  const packageName = typeof packageJson?.name === "string" ? packageJson.name : "";
  const displayName = typeof packageJson?.displayName === "string" ? packageJson.displayName : "";
  const name = displayName || packageName || basename(root);
  const packageDescription =
    typeof packageJson?.description === "string" ? packageJson.description.trim() : "";

  const readme = await readText(join(root, "README.md"));
  const agents = await readText(join(root, "AGENTS.md"));
  const directivePath = findProjectDirective(agents);
  const directive = directivePath
    ? await readText(isAbsolute(directivePath) ? directivePath : join(root, directivePath))
    : "";

  const readmeParagraph = firstParagraph(readme);
  const identity = extractIdentity(directive) || firstParagraph(directive);
  const description = packageDescription || readmeParagraph;
  const instructionPaths = [
    agents ? "AGENTS.md" : "",
    directivePath ?? "",
    existsSync(join(root, ".agent", "rules", "general.md")) ? ".agent/rules/general.md" : "",
  ].filter((entry) => entry.length > 0);

  const summary = [
    "# Project",
    `- Name: ${name}`,
    description ? `- Description: ${description}` : "",
    identity ? `- Identity: ${truncate(identity, 900)}` : "",
    `- Repository: ${root}`,
    instructionPaths.length > 0
      ? `- Project instructions: ${instructionPaths.join(", ")}`
      : "",
    "- For questions about this project, answer from this section and local files, not web search.",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    name,
    aliases: deriveAliases(packageName, displayName, basename(root)),
    description,
    summary,
    instructionPaths,
  };
}

function deriveAliases(...values: string[]): string[] {
  const aliases = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length < 3) continue;
    aliases.add(trimmed);
    const unscoped = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
    aliases.add(unscoped);
    const words = unscoped.split(/[-_.\s]+/).filter((word) => word.length >= 4);
    if (words.length > 1) aliases.add(words[0]);
    if (words.length > 0) aliases.add(words.join(" "));
  }
  return [...aliases].filter((alias) => alias.length >= 4);
}

function extractIdentity(markdown: string): string {
  const start = /^##\s+.*(Project Identity|Identity|Overview).*$/im.exec(markdown);
  if (!start) return "";
  const from = start.index + start[0].length;
  const rest = markdown.slice(from);
  const end = /^##\s+/m.exec(rest);
  return plainText(end ? rest.slice(0, end.index) : rest);
}

function firstParagraph(markdown: string): string {
  const cleaned = markdown
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/^#\s+.*$/m, "")
    .trim();
  const block = cleaned.split(/\n{2,}/).find((entry) => entry.trim().length > 0) ?? "";
  return plainText(block);
}

function plainText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\$([^$]+)\$/g, "$1")
    .replace(/\\text\{([^}]+)\}/g, "$1")
    .replace(/\\[a-zA-Z]+\{([^}]+)\}/g, "$1")
    .replace(/\\[,;:!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function readText(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3).trimEnd()}...` : text;
}
