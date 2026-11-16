import { skillSourceVersion } from "./skill-state";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import type { SkillDiagnostic, SkillDirectory, SkillDocument, SkillScope } from "./skills";
import { loadSkillSidecar } from "./skill-metadata";

interface SkillCandidate {
  path: string;
  scope: SkillScope;
  sourceRoot: string;
}

function failure(kind: SkillDiagnostic["kind"], path: string, error: unknown): SkillDiagnostic {
  const code = (error as NodeJS.ErrnoException)?.code;
  return {
    kind, path, severity: "error",
    message: code ? `${code}: ${error instanceof Error ? error.message : String(error)}`
      : error instanceof Error ? error.message : String(error),
  };
}

export async function discoverSkillDocuments(
  directories: readonly SkillDirectory[],
  parse: (raw: string, path: string, fallbackName: string, scope: SkillScope) => SkillDocument,
): Promise<{ documents: SkillDocument[]; diagnostics: SkillDiagnostic[] }> {
  const diagnostics: SkillDiagnostic[] = [];
  const candidates: SkillCandidate[] = [];
  const roots = new Set<string>();
  for (const directory of directories) {
    try {
      const canonical = await realpath(directory.path);
      if (roots.has(canonical)) continue;
      const entries = await readdir(canonical, { withFileTypes: true });
      roots.add(canonical);
      entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      for (const entry of entries) {
        const path = join(directory.path, entry.name);
        try {
          const type = entry.isSymbolicLink() ? await stat(path) : entry;
          if (type.isDirectory()) {
            const skillPath = join(path, "SKILL.md");
            try { await lstat(skillPath); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
              throw error;
            }
            candidates.push({ path: skillPath, scope: directory.scope, sourceRoot: directory.path });
          } else if (type.isFile() && entry.name.toLowerCase().endsWith(".md") && entry.name.toLowerCase() !== "readme.md") {
            candidates.push({ path, scope: directory.scope, sourceRoot: directory.path });
          }
        } catch (error) { diagnostics.push(failure("file", path, error)); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory.optional !== false) continue;
      diagnostics.push(failure("directory", directory.path, error));
    }
  }

  const files = new Set<string>();
  const documents: SkillDocument[] = [];
  for (const candidate of candidates) {
    let path: string;
    let raw: string;
    try {
      path = await realpath(candidate.path);
      if (files.has(path)) continue;
      files.add(path);
      raw = await readFile(path, "utf8");
    } catch (error) {
      diagnostics.push(failure("file", candidate.path, error));
      continue;
    }
    try {
      const fallbackName = basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path, extname(path));
      documents.push(await loadSkillSidecar({ ...parse(raw, path, fallbackName, candidate.scope), sourceRoot: candidate.sourceRoot, version: await skillSourceVersion(path, raw) }));
    } catch (error) { diagnostics.push(failure("parse", candidate.path, error)); }
  }

  const groups = new Map<string, SkillDocument[]>();
  for (const document of documents) {
    const key = document.name.trim().toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(document);
    groups.set(key, group);
  }
  const reserved = new Set(groups.keys());
  for (const group of groups.values()) {
    if (group.length === 1) {
      group[0].id = group[0].name;
      continue;
    }
    for (const document of group) {
      const prefix = document.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "skill";
      const hash = createHash("sha256").update(document.path).digest("hex");
      const base = `${prefix}--${document.scope}-${hash.slice(0, 12)}`;
      let id = base;
      let suffix = 1;
      while (reserved.has(id)) id = `${base}-${suffix++}`;
      document.id = id;
      reserved.add(id);
    }
    diagnostics.push({
      kind: "conflict", severity: "warning", path: group[0].path,
      message: `Several skills are named "${group[0].name}". Choose an exact ID; the bare name is ambiguous.`,
      skillName: group[0].name, ids: group.map((document) => document.id!),
      paths: group.map((document) => document.path),
    });
  }
  for (const document of documents) {
    for (const notice of document.metadataNotices ?? []) {
      diagnostics.push({ ...notice, kind: "metadata", skillName: document.name, ids: [document.id!], paths: [document.path] });
    }
  }
  return { documents, diagnostics };
}
