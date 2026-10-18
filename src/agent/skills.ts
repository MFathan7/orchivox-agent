import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { AgentTool, ToolRegistry } from "../tools/registry";

export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  when_to_use: z.string().min(1).optional(),
  allowed_tools: z.array(z.string().min(1)).optional(),
  model_role: z.enum(["main", "fast", "advisor"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export type SkillScope = "project" | "global" | "custom";

export interface SkillDocument {
  name: string;
  description: string;
  whenToUse?: string;
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

  return {
    name,
    description,
    whenToUse: frontmatter.when_to_use,
    allowedTools: frontmatter.allowed_tools,
    modelRole: frontmatter.model_role,
    path,
    scope,
    body: body.trim(),
  };
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

    await mkdir(this.skillsDir, { recursive: true });

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

  buildIndexPrompt(limit = 40): string {
    const documents = this.listDocuments().slice(0, limit);
    if (documents.length === 0) {
      return [
        "Skills: none installed.",
        `Add one as ${join(this.skillsDir, "<name>", "SKILL.md")} with yaml frontmatter (name, description).`,
      ].join(" ");
    }

    return [
      "Available skills. Call the `skill` tool with the exact name to load the full instructions before using a skill.",
      ...documents.map((document) => `- ${document.name}: ${document.description}`),
    ].join("\n");
  }

  registerTools(registry: ToolRegistry): void {
    registry.register(this.skillTool());
    registry.register(this.skillListTool());
  }

  private skillTool(): AgentTool {
    return {
      name: "skill",
      description:
        "Load the full instructions for an installed skill by name. Call this when the task matches a skill description, then follow the loaded instructions.",
      parameters: z.object({
        name: z.string().min(1).describe("Skill name exactly as listed in the system prompt"),
      }),
      readOnly: true,
      execute: (args) => {
        const { name } = args as { name: string };
        const document = this.get(name);
        if (!document) {
          const available = this.listDocuments().map((entry) => entry.name);
          return available.length === 0
            ? `unknown skill "${name}": no skills are installed`
            : `unknown skill "${name}". Available skills: ${available.join(", ")}`;
        }

        return [
          `# Skill: ${document.name}`,
          document.description,
          document.whenToUse ? `When to use: ${document.whenToUse}` : "",
          document.allowedTools
            ? `Allowed tools for this turn: ${
                document.allowedTools.length > 0
                  ? `${document.allowedTools.join(", ")} (plus core read-only tools)`
                  : "none (core read-only tools only)"
              }`
            : "",
          `Source: ${document.path}`,
          "",
          document.body,
        ]
          .filter((line) => line.length > 0)
          .join("\n");
      },
    };
  }

  private skillListTool(): AgentTool {
    return {
      name: "skill_list",
      description: "List installed skills with their descriptions and source paths.",
      parameters: z.object({}),
      readOnly: true,
      execute: () => {
        const documents = this.listDocuments();
        if (documents.length === 0) return "no skills are installed";
        return documents
          .map((document) => `- ${document.name}: ${document.description} (${document.scope}, ${document.path})`)
          .join("\n");
      },
    };
  }
}

export function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
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
