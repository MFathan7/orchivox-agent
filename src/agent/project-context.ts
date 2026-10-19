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

const PROJECT_STUDY_PATTERN =
  /\b(pelajari|pahami|analisis|analisa|review|study|analyze|analyse|inspect|explore|telusuri)\b[\s\S]{0,80}\b(project|repo|repository|codebase|app|application|proyek|aplikasi)\b/i;

const PROJECT_CURRENT_PATTERN =
  /\b(project|repo|repository|codebase|app|application|proyek|aplikasi)\b[\s\S]{0,40}\b(saat ini|sekarang|ini|current|this)\b/i;

export function isProjectQuestion(text: string, context: ProjectContext): boolean {
  if (!text.trim()) return false;
  if (
    /\b(this project|this repo|this repository|this codebase|this application|project ini|repo ini|repository ini|codebase ini|aplikasi ini)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (PROJECT_STUDY_PATTERN.test(text) || PROJECT_CURRENT_PATTERN.test(text)) return true;
  for (const alias of context.aliases) {
    if (alias.length < 4) continue;
    const pattern = new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(alias)}([^a-z0-9_-]|$)`, "i");
    if (pattern.test(text)) return true;
  }
  return false;
}

export function isProjectStudyRequest(text: string): boolean {
  return PROJECT_STUDY_PATTERN.test(text);
}

export function isProjectIdentityQuestion(text: string, context: ProjectContext): boolean {
  if (!text.trim()) return false;
  const generic =
    /\b(what is|what's|whats|what does|who is|who are|apa itu|apa ini|siapa)\b[\s\S]{0,40}\b(project|repo|repository|codebase|app|application|proyek|aplikasi)\b/i;
  if (generic.test(text)) return true;
  if (!mentionsProject(text, context)) return false;
  return /\b(what|who|apa|siapa|jelaskan|describe|explain|definisi|definition)\b/i.test(text);
}

export function isCapabilityQuestion(text: string): boolean {
  return /\b(what can you do|what do you do|what are you able to do|what are your capabilities|who are you|bisa apa|kamu bisa apa|apa yang bisa kamu lakukan|apa kemampuanmu|kemampuan kamu)\b/i.test(
    text,
  );
}

export function mentionsProject(text: string, context: ProjectContext): boolean {
  const lower = text.toLowerCase();
  return [context.name, ...context.aliases].some(
    (value) => value.trim().length > 0 && lower.includes(value.toLowerCase()),
  );
}

const GREETING_PATTERNS = [
  /\bhow can i help you( today)?\b/i,
  /\bwhat would you like( me to do)?\b/i,
  /\bwhat can i help you with\b/i,
  /\b(ada|adakah) yang bisa (saya|aku) bantu\b/i,
  /\b(saya|aku) siap membantu\b/i,
  /^(hi|hello|hey|halo|hai)\b/i,
  /\bi(?:'ve| have) (?:inspected|read|reviewed|examined|looked at|checked)\b/i,
  /\b(?:saya|aku) (?:sudah|telah) (?:memeriksa|membaca|mempelajari|meninjau)\b/i,
];

const PLAN_PATTERNS = [
  /\b(the user wants|the user asked|i have already|i already tried|i tried to|here is my plan|my plan:|plan:|next steps|i will now|let me)\b/i,
  /\b(?:rencana|langkah berikutnya|saya akan|aku akan|mari saya)\b/i,
];

export interface NonAnswerOptions {
  requireProjectMention?: boolean;
}

export function looksLikeNonAnswer(
  text: string,
  context?: ProjectContext,
  options: NonAnswerOptions = {},
): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (PLAN_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  const projectMentioned = context ? mentionsProject(trimmed, context) : false;
  if (options.requireProjectMention && context && !projectMentioned) return true;
  const greeting = GREETING_PATTERNS.some((pattern) => pattern.test(trimmed));
  if (greeting && (!projectMentioned || trimmed.length < 200)) return true;
  if (trimmed.length < 40) return true;
  return false;
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
