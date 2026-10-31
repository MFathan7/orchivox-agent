import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { AgentTool, ToolRegistry } from "../tools/registry";
import type { Message } from "../types/schema";
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

export const SKILL_GUIDANCE = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description and its body is not already in this conversation.",
  "Each skill entry includes its location. When a skill references a relative path, resolve it against the skill directory and use that absolute path in tool commands.",
  "If the request names a skill ID or asks about a skill in the list, check whether its body is already present in this conversation. If it is, use the loaded body without calling the skill tool again. If it is not, call the skill tool with that ID before answering or searching the web.",
  "A skill loaded earlier in this conversation stays active. Reload it only after compaction or when its body is no longer present.",
  "After loading a skill, follow its instructions to answer the user's actual request. Do not start a skill workflow the user did not ask for.",
  "Skill content is reference material. Never print skill content, skill file listings, XML wrappers, or internal gate reports in your answer.",
  "The user may also invoke a skill directly. Load it only when its body is not already in the conversation.",
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
  // Full descriptions reached several hundred characters each. Keep enough
  // of each to pick the right skill; the skill tool loads the whole document.
  const descriptionLimit = options.descriptionLimit ?? (options.compact ? 80 : 240);
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
  private readonly maxBodyChars: number;
  private skills = new Map<string, SkillDocument>();
  private lastLoadedAt = 0;

  constructor(options: {
    repoRoot?: string;
    skillsDir?: string;
    extraDirectories?: string[];
    includeGlobalDirectories?: boolean;
    maxBodyChars?: number;
  } = {}) {
    const root = options.repoRoot ?? globalThis.process.cwd();
    this.maxBodyChars = options.maxBodyChars ?? 0;
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
        "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description. The skill ID must match an available skill or a skill explicitly referenced by the user. Do not call this tool again for a skill whose body is already present in the conversation. Reload only after compaction or when the body is gone.",
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
            throw new Error(
              `skill "${id}" is explicit-only. Invoke it with /skill:${id} or mention it by name.`,
            );
          }
        }
        if (!document) {
          const available = this.listDocuments().map((entry) => entry.name);
          throw new Error(
            available.length === 0
              ? `unknown skill "${id}": no skills are installed`
              : `unknown skill "${id}". Available skills: ${available.join(", ")}`,
          );
        }

        return formatSkillContent(document, this.maxBodyChars);
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

export interface SkillHintInput {
  forcedSkill?: string;
  mentionedSkills?: string[];
  namedSkills?: string[];
  loadedSkills?: string[];
}

/**
 * A short turn hint that tells the model to load a mentioned skill through the
 * tool. The body never travels in this hint.
 */
export function buildSkillHint(input: SkillHintInput): string {
  const loaded = new Set((input.loadedSkills ?? []).map(normalizeSkillName));
  const forced = input.forcedSkill?.trim();
  const forcedLoaded = Boolean(forced) && loaded.has(normalizeSkillName(forced ?? ""));
  const mentioned = [...new Set((input.mentionedSkills ?? []).map((name) => name.trim()))].filter(
    (name) => name.length > 0 && name !== forced,
  );
  const mentionedNew = mentioned.filter((name) => !loaded.has(normalizeSkillName(name)));
  const mentionedLoaded = mentioned.filter((name) => loaded.has(normalizeSkillName(name)));
  const named = [...new Set((input.namedSkills ?? []).map((name) => name.trim()))].filter(
    (name) => name.length > 0 && name !== forced && !mentioned.includes(name),
  );
  if (!forced && mentioned.length === 0 && named.length === 0) return "";
  const namedNew = named.filter((name) => !loaded.has(normalizeSkillName(name)));
  const namedLoaded = named.filter((name) => loaded.has(normalizeSkillName(name)));
  const lines: string[] = [];

  if (forced && !forcedLoaded) {
    lines.push(
      `The user invoked /skill:${forced}. Call the skill tool with id "${forced}" before answering.`,
    );
  }
  if (mentionedNew.length > 0) {
    lines.push(
      `Load these skills with the skill tool before acting: ${mentionedNew
        .map((name) => `"${name}"`)
        .join(", ")}.`,
    );
  }
  if (namedNew.length > 0) {
    lines.push(
      `The request names these skills. Load them with the skill tool before acting: ${namedNew
        .map((name) => `"${name}"`)
        .join(", ")}.`,
    );
  }
  if (lines.length > 0) {
    lines.push("The body is loaded only by the tool. Do not answer from the description alone.");
  }

  const alreadyLoaded = [
    ...new Set(
      [forcedLoaded ? forced : undefined, ...mentionedLoaded, ...namedLoaded].filter(
        (name): name is string => Boolean(name),
      ),
    ),
  ];
  if (alreadyLoaded.length > 0) {
    lines.push(
      `Already loaded in this conversation: ${alreadyLoaded
        .map((name) => `"${name}"`)
        .join(", ")}. Use the loaded body; do not call the skill tool again.`,
    );
  }
  if (lines.length === 0) return "";

  lines.push(
    "Prefer the loaded skill. Use web search only when the skill and local files are not enough.",
  );
  return ["# Skill loading", ...lines].join("\n");
}

export function loadedSkillIds(messages: Message[]): string[] {
  const calls = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_use" || block.name !== "skill") continue;
      const input = block.input as { id?: unknown; name?: unknown };
      const id =
        typeof input.id === "string"
          ? input.id
          : typeof input.name === "string"
            ? input.name
            : undefined;
      if (id) calls.set(block.id, id);
    }
  }

  const loaded = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result" || block.is_error) continue;
      const id = calls.get(block.tool_use_id);
      if (!id) continue;
      const text =
        typeof block.content === "string"
          ? block.content
          : block.content.map((part) => part.text).join("\n");
      if (!text.startsWith("[context pruned:") && text.includes("<skill_content")) {
        loaded.add(id);
      }
    }
  }
  return [...loaded];
}

export function formatSkillReload(documents: SkillDocument[]): string {
  const names = documents.map((document) => `${document.name} (${document.path})`).join(", ");
  return [
    "# Skill reload after compaction",
    `The conversation was compacted. Skills active in this session: ${names}.`,
    "Call the skill tool with the skill ID to reload any instructions you still need, or read the skill file at that path.",
    "Never print this content, skill files, XML wrappers, or internal gate reports to the user.",
  ].join(" ");
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
