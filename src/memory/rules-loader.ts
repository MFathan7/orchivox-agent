import { readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { findProjectDirective } from "../agent/project-context";
import { pathExists } from "../vcs/git";

export interface RulesLoaderOptions {
  rootPath?: string;
}

export class RulesLoader {
  private readonly root: string;
  private readonly injected = new Set<string>();

  constructor(options: RulesLoaderOptions = {}) {
    this.root = (options.rootPath ?? globalThis.process.cwd()).replace(/[\\/]+$/, "");
  }

  async getRulesForFile(targetFilePath: string): Promise<string> {
    const relative = toRelative(targetFilePath, this.root);
    const slash = relative.lastIndexOf("/");
    const dir = slash === -1 ? "" : relative.slice(0, slash);
    const levels = dir === "" ? [""] : ["", ...expandLevels(dir)];

    const sections: string[] = [];
    for (const level of levels) {
      for (const candidate of await this.candidates(level, relative)) {
        if (this.injected.has(candidate)) continue;
        if (!(await pathExists(candidate))) continue;
        this.injected.add(candidate);
        const content = (await Bun.file(candidate).text()).trimEnd();
        if (content.length > 0) sections.push(`# ${labelFor(candidate, this.root)}\n${content}`);
      }
    }
    return sections.join("\n\n");
  }

  async getGlobalRules(): Promise<string> {
    const rootAgents = `${this.root}/AGENTS.md`;
    let rootAgentsContent = "";
    if (await pathExists(rootAgents)) {
      rootAgentsContent = (await Bun.file(rootAgents).text()).trimEnd();
    }
    const directive = findProjectDirective(rootAgentsContent);
    const directivePath = directive
      ? isAbsolute(directive)
        ? directive
        : resolve(this.root, directive)
      : undefined;
    const candidates = [
      rootAgents,
      `${this.root}/CLAUDE.md`,
      `${this.root}/.agent/rules/general.md`,
      ...(directivePath ? [directivePath] : []),
    ];
    const sections: string[] = [];
    for (const candidate of new Set(candidates)) {
      if (this.injected.has(candidate)) continue;
      if (!(await pathExists(candidate))) continue;
      this.injected.add(candidate);
      const content = (await Bun.file(candidate).text()).trimEnd();
      if (content.length > 0) sections.push(`# ${labelFor(candidate, this.root)}\n${content}`);
    }
    return sections.join("\n\n");
  }

  reset(): void {
    this.injected.clear();
  }

  loadedRules(): string[] {
    return [...this.injected];
  }

  private async candidates(level: string, relativeTarget: string): Promise<string[]> {
    const levelDir = level === "" ? this.root : `${this.root}/${level}`;
    const out = [`${levelDir}/AGENTS.md`, `${levelDir}/CLAUDE.md`];
    if (level === "") out.push(`${this.root}/.agent/rules/general.md`);

    const rulesDir = level === "" ? `${this.root}/.agent/rules` : `${this.root}/.agent/rules/${level}`;
    const baseName = relativeTarget.slice(relativeTarget.lastIndexOf("/") + 1);
    for (const fileName of await listMarkdownFiles(rulesDir)) {
      const pattern = fileName.slice(0, -".md".length);
      if (level === "" && pattern.toLowerCase() === "general") continue;
      const glob = new Bun.Glob(pattern);
      if (glob.match(relativeTarget) || glob.match(baseName)) out.push(`${rulesDir}/${fileName}`);
    }
    return out;
  }
}

function expandLevels(dir: string): string[] {
  const parts = dir.split("/");
  const levels: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    levels.push(parts.slice(0, index + 1).join("/"));
  }
  return levels;
}

function toRelative(targetFilePath: string, root: string): string {
  const normalized = targetFilePath.replace(/\\/g, "/");
  const rootPrefix = `${root.replace(/\\/g, "/")}/`;
  const relative = normalized.startsWith(rootPrefix) ? normalized.slice(rootPrefix.length) : normalized;
  return relative.replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

function labelFor(candidate: string, root: string): string {
  const normalized = candidate.replace(/\\/g, "/");
  const rootPrefix = `${root.replace(/\\/g, "/")}/`;
  return normalized.startsWith(rootPrefix) ? normalized.slice(rootPrefix.length) : normalized;
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
