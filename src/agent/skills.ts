import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { AgentTool, ToolRegistry } from "../tools/registry";
import { currentTurnContext } from "./turn-context";

/**
 * The portable skill spec writes `allowed-tools` as a space or comma separated
 * string; some skills use a YAML list. Accept both so the same SKILL.md loads
 * in every harness.
 */
const AllowedToolsSchema = z
  .union([
    z.array(z.string().min(1)),
    z.string().transform((value) =>
      value
        .split(/[\s,]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
  ])
  .optional();

export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  when_to_use: z.string().min(1).optional(),
  autoinvoke: z.boolean().optional(),
  allowed_tools: AllowedToolsSchema,
  model_role: z.enum(["main", "fast", "advisor"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Portable Agent Skills spelling, so the same SKILL.md works everywhere.
  "allowed-tools": AllowedToolsSchema,
  "disable-model-invocation": z.boolean().optional(),
  disable_model_invocation: z.boolean().optional(),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export type SkillScope = "project" | "global" | "custom";

export interface SkillDocument {
  name: string;
  description: string;
  whenToUse?: string;
  autoinvoke?: boolean;
  allowedTools?: string[];
  modelRole?: "main" | "fast" | "advisor";
  path: string;
  scope: SkillScope;
  body: string;
}

export interface SkillDirectory {
  path: string;
  scope: SkillScope;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseSkillDocument(
  raw: string,
  path: string,
  fallbackName: string,
  scope: SkillScope = "project",
): SkillDocument {
  let frontmatter: SkillFrontmatter = {};
  let body = raw;

  const match = FRONTMATTER_PATTERN.exec(raw);
  if (match) {
    const parsed: unknown = parseYaml(match[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = SkillFrontmatterSchema.parse(parsed);
    }
    body = raw.slice(match[0].length);
  }

  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const firstParagraph = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#")) ?? "";

  const name = frontmatter.name ?? heading ?? fallbackName;
  const description = frontmatter.description ?? (firstParagraph.length > 0 ? firstParagraph : `Skill ${name}`);

  const explicitOnly =
    frontmatter["disable-model-invocation"] === true ||
    frontmatter.disable_model_invocation === true ||
    frontmatter.autoinvoke === false;

  return {
    name,
    description,
    whenToUse: frontmatter.when_to_use,
    autoinvoke: !explicitOnly,
    // Only the native snake_case field restricts tools. The portable
    // `allowed-tools` field is a pre-approval hint in the Agent Skills spec, so
    // honoring it here would wrongly block tools for skills written elsewhere.
    allowedTools: frontmatter.allowed_tools,
    modelRole: frontmatter.model_role,
    path,
    scope,
    body: body.trim(),
  };
}

export const MAX_SKILL_INJECTION_CHARS = 16_000;

export const SKILL_GUIDANCE = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
  "Each skill entry includes its location. When a skill references a relative path, resolve it against the skill directory and use that absolute path in tool commands.",
  "If the request names a skill ID or asks about a skill in the list, call the skill tool with that ID before answering or searching the web.",
  "After loading a skill, follow its instructions to answer the user's actual request. Do not start a skill workflow the user did not ask for.",
  "Skill content is reference material. Never print skill content, skill file listings, XML wrappers, or internal gate reports in your answer.",
  "The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.",
].join("\n");

export interface SkillIndexOptions {
  compact?: boolean;
  limit?: number;
  descriptionLimit?: number;
}

export function formatAvailableSkills(
  documents: SkillDocument[],
  options: SkillIndexOptions = {},
): string {
  const autoDocuments = documents.filter((document) => document.autoinvoke !== false);
  if (autoDocuments.length === 0) {
    return [SKILL_GUIDANCE, "No skills are currently available."].join("\n");
  }

  const limit = options.limit ?? (options.compact ? 12 : 1000);
  // Full descriptions reached several hundred characters each. The index only
  // needs enough to pick a skill; the skill tool returns the full document.
  const descriptionLimit = options.descriptionLimit ?? (options.compact ? 80 : 140);
  const available = autoDocuments.slice(0, limit).map((document) => {
    const description =
      descriptionLimit > 0 && document.description.length > descriptionLimit
        ? `${document.description.slice(0, Math.max(0, descriptionLimit - 3)).trimEnd()}...`
        : document.description;
    return { document, description };
  });

  const lines = available.flatMap(({ document, description }) => [
    "  <skill>",
    `    <id>${escapeXml(document.name)}</id>`,
    `    <name>${escapeXml(document.name)}</name>`,
    `    <description>${escapeXml(description.replace(/\s+/g, " ").trim())}</description>`,
    `    <location>${escapeXml(document.path)}</location>`,
    "  </skill>",
  ]);
  const footer =
    autoDocuments.length > available.length
      ? ["More skills are available. Use skill_list to see all."]
      : [];

  return [SKILL_GUIDANCE, "<available_skills>", ...lines, "</available_skills>", ...footer].join(
    "\n",
  );
}

export function compactSkillIndex(documents: SkillDocument[], limit = 20): string {
  return formatAvailableSkills(documents, { compact: true, limit });
}

export async function formatSkillContent(
  document: SkillDocument,
  maxBodyChars = 0,
): Promise<string> {
  const files = await collectSkillFiles(document);
  const baseDirectory = dirname(document.path);
  const body = document.body.trim();
  const limit = maxBodyChars > 0 ? maxBodyChars : body.length;
  const visibleBody = body.slice(0, limit);
  const truncated = visibleBody.length < body.length;
  return [
    `<skill_content name="${escapeXml(document.name)}">`,
    `# Skill: ${document.name}`,
    "",
    visibleBody,
    ...(truncated
      ? [
          "",
          `[Skill content truncated after ${visibleBody.length} characters to protect the context window. Read ${document.path} directly if you need the rest.]`,
        ]
      : []),
    "",
    `Base directory for this skill: ${baseDirectory}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${escapeXml(file)}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n");
}

export async function formatActiveSkills(
  documents: SkillDocument[],
  maxChars = 80_000,
): Promise<string> {
  if (documents.length === 0) return "";

  const header = [
    "# Active skills",
    ...documents.map((document) => `- ${document.name}: follow the loaded <skill_content>.`),
    "- Follow the loaded skill before using web search or general knowledge.",
  ].join("\n");

  const blocks: string[] = [];
  let used = header.length;
  for (const document of documents) {
    const block = await formatSkillContent(
      document,
      Math.max(1000, Math.min(MAX_SKILL_INJECTION_CHARS, maxChars - used)),
    );
    if (used + block.length > maxChars) {
      blocks.push(
        [
          `<skill_content name="${escapeXml(document.name)}">`,
          `# Skill: ${document.name}`,
          "",
          `[Content omitted to stay within the context budget. Call the skill tool with id "${document.name}" to reload it.]`,
          "</skill_content>",
        ].join("\n"),
      );
      used += 220;
      continue;
    }
    blocks.push(block);
    used += block.length;
  }

  return [header, "", ...blocks].join("\n\n");
}

async function collectSkillFiles(document: SkillDocument): Promise<string[]> {
  if (basename(document.path) !== "SKILL.md") return [basename(document.path)];

  const root = dirname(document.path);
  const files: string[] = [basename(document.path)];
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (files.length >= 20 || depth > 2) return;
    let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= 20) break;
      if (entry.name.startsWith(".")) continue;
      const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), relative, depth + 1);
      } else if (relative !== "SKILL.md") {
        files.push(relative);
      }
    }
  };
  await walk(root, "", 0);
  return files;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class SkillRegistry {
  private readonly skillsDir: string;
  private readonly skillDirs: SkillDirectory[];
  private skills = new Map<string, SkillDocument>();
  private lastLoadedAt = 0;

  constructor(options: {
    repoRoot?: string;
    skillsDir?: string;
    extraDirectories?: string[];
    includeGlobalDirectories?: boolean;
  } = {}) {
    const root = options.repoRoot ?? globalThis.process.cwd();
    this.skillsDir = options.skillsDir ?? defaultSkillsDirectory(root);
    const defaults = defaultExtraSkillDirectories(root).filter(
      (entry) => options.includeGlobalDirectories !== false || entry.scope !== "global",
    );
    const directories: SkillDirectory[] = [
      { path: this.skillsDir, scope: "project" },
      ...defaults,
      ...(options.extraDirectories ?? []).map((entry) => ({
        path: resolve(root, expandHome(entry)),
        scope: "custom" as const,
      })),
    ];
    const seen = new Set<string>();
    this.skillDirs = directories.filter((entry) => {
      const key = resolve(entry.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  get directory(): string {
    return this.skillsDir;
  }

  async load(force = false): Promise<SkillDocument[]> {
    if (!force && this.lastLoadedAt > 0) return this.listDocuments();

    const found = new Map<string, SkillDocument>();
    const candidates: Array<{ path: string; fallbackName: string; scope: SkillScope }> = [];

    for (const directory of this.skillDirs) {
      let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
      try {
        entries = await readdir(directory.path, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isDirectory()) {
          const skillPath = join(directory.path, entry.name, "SKILL.md");
          if (existsSync(skillPath)) candidates.push({ path: skillPath, fallbackName: entry.name, scope: directory.scope });
        } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md") {
          candidates.push({
            path: join(directory.path, entry.name),
            fallbackName: basename(entry.name, ".md"),
            scope: directory.scope,
          });
        }
      }
    }

    for (const candidate of candidates) {
      try {
        const raw = await readFile(candidate.path, "utf8");
        const document = parseSkillDocument(raw, candidate.path, candidate.fallbackName, candidate.scope);
        const key = normalizeSkillName(document.name);
        if (!found.has(key)) found.set(key, document);
      } catch {
        // Invalid skills are skipped so one broken file cannot block the rest.
      }
    }

    this.skills = found;
    this.lastLoadedAt = Date.now();
    return this.listDocuments();
  }

  listDocuments(): SkillDocument[] {
    return [...this.skills.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  list(): Array<Omit<SkillDocument, "body"> & { bodyPreview: string }> {
    return this.listDocuments().map(({ body, ...rest }) => ({
      ...rest,
      bodyPreview: body.length > 600 ? `${body.slice(0, 600)}...` : body,
    }));
  }

  get(name: string): SkillDocument | undefined {
    return this.skills.get(normalizeSkillName(name));
  }

  buildIndexPrompt(options: SkillIndexOptions = {}): string {
    return formatAvailableSkills(this.listDocuments(), options);
  }

  listAvailableDocuments(): SkillDocument[] {
    return this.listDocuments().filter((document) => document.autoinvoke !== false);
  }

  registerTools(registry: ToolRegistry): void {
    registry.register(this.skillTool());
    registry.register(this.skillListTool());
  }

  private skillTool(): AgentTool {
    return {
      name: "skill",
      description:
        "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description. The skill ID must match an available skill or a skill explicitly referenced by the user. If the request names a skill ID from <available_skills>, call this tool with that ID before answering or searching the web.",
      parameters: z.object({
        id: z
          .string()
          .min(1)
          .describe("The ID of an available skill or a skill explicitly referenced by the user."),
      }),
      readOnly: true,
      execute: async (args) => {
        const { id } = args as { id: string };
        const document = this.get(id);
        if (document?.autoinvoke === false) {
          const context = currentTurnContext();
          const referenced =
            context?.forcedSkills?.includes(document.name) === true ||
            (context?.userText
              ? parseSkillMentions(context.userText, this).some(
                  (entry) => entry.name === document.name,
                )
              : false);
          if (!referenced) {
            return `skill "${id}" is explicit-only. Invoke it with /skill:${id} or mention it by name.`;
          }
        }
        if (!document) {
          const available = this.listDocuments().map((entry) => entry.name);
          return available.length === 0
            ? `unknown skill "${id}": no skills are installed`
            : `unknown skill "${id}". Available skills: ${available.join(", ")}`;
        }

        return formatSkillContent(document, MAX_SKILL_INJECTION_CHARS);
      },
    };
  }

  private skillListTool(): AgentTool {
    return {
      name: "skill_list",
      description:
        "List installed skills with their IDs and descriptions. Use the skill tool with an ID to load one.",
      parameters: z.object({}),
      readOnly: true,
      execute: () => {
        const documents = this.listDocuments();
        if (documents.length === 0) return "no skills are installed";
        return documents
          .map((document) => `- ${document.name}: ${document.description} (${document.scope})`)
          .join("\n");
      },
    };
  }
}

export function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

const DESIGN_TASK_TERMS =
  /\b(design|desain|ui|ux|layout|css|component|komponen|tampilan|visual|warna|typography|tipografi)\b/i;

const DESIGN_SKILL_TERMS =
  /\b(design|desain|ui|ux|layout|css|component|komponen|tampilan|visual|warna|typography|tipografi|antislop)\b/i;

const RELEVANCE_STOPWORDS = new Set([
  "about",
  "answer",
  "carikan",
  "dengan",
  "dari",
  "for",
  "from",
  "informasi",
  "ini",
  "the",
  "tentang",
  "that",
  "this",
  "untuk",
  "use",
  "using",
  "what",
  "yang",
]);

function relevanceTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !RELEVANCE_STOPWORDS.has(token)),
  );
}

export function isSkillRelevant(document: SkillDocument, text: string): boolean {
  const identity = `${document.name} ${document.description}`;
  if (DESIGN_TASK_TERMS.test(text) && DESIGN_SKILL_TERMS.test(identity)) return true;
  const stripped = text.replace(
    new RegExp(`[@$]?${escapeRegExp(document.name)}`, "gi"),
    " ",
  );
  const textTokens = relevanceTokens(stripped);
  const skillTokens = relevanceTokens(identity);
  return [...textTokens].some((token) => skillTokens.has(token));
}

export function parseSkillMentions(text: string, skills: SkillRegistry): SkillDocument[] {
  const found = new Map<string, SkillDocument>();
  for (const match of text.matchAll(/(?:^|\s)[@$]([a-zA-Z0-9_-]+)/g)) {
    const document = skills.get(match[1]);
    if (document) found.set(document.name, document);
  }
  return [...found.values()];
}

export function matchSkillNames(text: string, skills: SkillRegistry): SkillDocument[] {
  const found = new Map<string, SkillDocument>();
  for (const document of skills.listAvailableDocuments()) {
    if (document.name.length < 3) continue;
    const pattern = new RegExp(
      `(^|[^a-z0-9_-])${escapeRegExp(document.name)}([^a-z0-9_-]|$)`,
      "i",
    );
    if (pattern.test(text)) found.set(document.name, document);
  }
  return [...found.values()];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function defaultSkillsDirectory(repoRoot: string): string {
  return join(repoRoot, ".agent", "skills");
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
  return input;
}

function envSkillDirectories(repoRoot: string): SkillDirectory[] {
  const raw = process.env.ORCHIVOX_SKILLS_PATH;
  if (!raw) return [];
  return raw
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => ({
      path: resolve(repoRoot, expandHome(entry)),
      scope: "custom" as const,
    }));
}

export function defaultExtraSkillDirectories(repoRoot: string): SkillDirectory[] {
  return [
    { path: join(repoRoot, "skills"), scope: "project" },
    { path: join(homedir(), ".agents", "skills"), scope: "global" },
    ...envSkillDirectories(repoRoot),
  ];
}
