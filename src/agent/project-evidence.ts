import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

import { runGit } from "../vcs/git";

const MAX_FILES = 4000;
const MAX_KEY_FILES = 14;
const MAX_FILE_CHARS = 12000;
const MAX_TOTAL_CHARS = 48000;
const MAX_TREE_LINES = 240;

const IGNORED_DIRS = new Set([
  ".git",
  ".agent",
  ".opencode",
  ".next",
  ".venv",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  "venv",
  "target",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".rb",
  ".php",
  ".swift",
  ".sh",
  ".sql",
]);

const MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "gemfile",
  "composer.json",
  "makefile",
  "dockerfile",
]);

const ENTRYPOINT_NAMES = new Set([
  "main.py",
  "__main__.py",
  "app.py",
  "manage.py",
  "index.ts",
  "index.js",
  "main.ts",
  "main.js",
  "main.go",
  "main.rs",
  "lib.rs",
]);

export interface ProjectEvidenceFile {
  path: string;
  content: string;
}

export interface ProjectEvidence {
  files: string[];
  keyFiles: ProjectEvidenceFile[];
  text: string;
}

async function listGitFiles(root: string): Promise<string[] | undefined> {
  const result = await runGit(root, ["ls-files", "-co", "--exclude-standard"], {
    allowFailure: true,
  }).catch(() => undefined);
  if (!result || result.exitCode !== 0) return undefined;
  const files = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return files.length > 0 ? files : undefined;
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    if (files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.name === ".git" || IGNORED_DIRS.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(relative(root, absolute));
      }
    }
  };

  await walk(root);
  return files;
}

function keyFileScore(path: string): number {
  const name = basename(path).toLowerCase();
  const extension = extname(name);
  const depth = path.split("/").length - 1;
  if (MANIFEST_NAMES.has(name)) return 100 - depth;
  if (name === "readme.md" || name.startsWith("readme.")) return 90 - depth;
  if (ENTRYPOINT_NAMES.has(name)) return 80 - depth;
  if (name === "calculator.py") return 78 - depth;
  if (depth === 0 && SOURCE_EXTENSIONS.has(extension)) return 70;
  if (depth <= 2 && SOURCE_EXTENSIONS.has(extension)) return 55 - depth;
  if (depth <= 2 && (name === "test" || name.includes("test") || path.includes("/tests/"))) return 40;
  return 0;
}

function pickKeyFiles(files: string[]): string[] {
  return files
    .filter((path) => {
      const lower = path.toLowerCase();
      if (lower.endsWith("agents.md") || lower.endsWith("claude.md")) return false;
      if (lower.startsWith(".agent/") || lower.startsWith(".opencode/")) return false;
      if (lower.includes("/node_modules/")) return false;
      return keyFileScore(path) > 0;
    })
    .sort((left, right) => keyFileScore(right) - keyFileScore(left) || left.length - right.length || left.localeCompare(right))
    .slice(0, MAX_KEY_FILES);
}

async function readTextFile(root: string, path: string): Promise<string | undefined> {
  try {
    const info = await stat(join(root, path));
    if (!info.isFile() || info.size > 2_000_000) return undefined;
    const content = await readFile(join(root, path), "utf8");
    if (content.includes("\u0000")) return undefined;
    return content;
  } catch {
    return undefined;
  }
}

function detectCommands(files: string[], keyFiles: ProjectEvidenceFile[]): string[] {
  const commands: string[] = [];
  const names = new Set(files.map((path) => basename(path).toLowerCase()));
  const hasTests = files.some(
    (path) =>
      /(^|\/)(tests?|__tests__)\//.test(path) ||
      /(^|\/)test_.*\.py$/i.test(path) ||
      /_test\.py$/i.test(path),
  );
  const packageFile = keyFiles.find((file) => file.path.endsWith("package.json"));
  if (packageFile) {
    try {
      const parsed = JSON.parse(packageFile.content) as { scripts?: Record<string, string> };
      for (const name of ["test", "typecheck", "build"]) {
        if (parsed.scripts?.[name]) commands.push(`package script ${name}: ${parsed.scripts[name]}`);
      }
    } catch {
      // A malformed manifest should not block the evidence report.
    }
  }
  if (
    hasTests &&
    (names.has("pyproject.toml") || names.has("setup.py") || names.has("requirements.txt"))
  ) {
    commands.push("python -m pytest");
  }
  if (names.has("cargo.toml")) commands.push("cargo test");
  if (names.has("go.mod")) commands.push("go test ./...");
  if (names.has("makefile")) commands.push("make test");
  return [...new Set(commands)];
}

function renderEvidence(
  files: string[],
  keyFiles: ProjectEvidenceFile[],
  commands: string[],
): string {
  const tree = files.slice(0, MAX_TREE_LINES).join("\n");
  const sections: string[] = [
    "# Project evidence",
    "The file list and file contents below were read from disk for this turn. Treat them as the source of truth.",
    "Do not mention a file unless it appears in the file list. Do not describe modules that do not exist.",
    "",
    `## File list (${files.length}${files.length > MAX_TREE_LINES ? `, first ${MAX_TREE_LINES} shown` : ""})`,
    tree,
  ];

  let used = 0;
  for (const file of keyFiles) {
    const remaining = MAX_TOTAL_CHARS - used;
    if (remaining <= 0) break;
    const limit = Math.min(MAX_FILE_CHARS, remaining);
    const content = file.content.slice(0, limit);
    if (content.trim().length === 0) continue;
    const truncated = file.content.length > content.length;
    sections.push(
      "",
      `## File: ${file.path}${truncated ? " (truncated)" : ""}`,
      content,
      truncated ? `[truncated after ${content.length} characters; read ${file.path} for the rest]` : "",
    );
    used += content.length;
  }

  if (commands.length > 0) {
    sections.push("", "## Commands", ...commands.map((command) => `- ${command}`));
  }
  return sections.join("\n");
}

export async function collectProjectEvidence(root: string): Promise<ProjectEvidence> {
  const gitFiles = await listGitFiles(root);
  const files = (gitFiles ?? (await walkFiles(root))).sort();
  const selected = pickKeyFiles(files);
  const keyFiles: ProjectEvidenceFile[] = [];
  for (const path of selected) {
    const content = await readTextFile(root, path);
    if (content !== undefined) keyFiles.push({ path, content });
  }
  const commands = detectCommands(files, keyFiles);
  return {
    files,
    keyFiles,
    text: renderEvidence(files, keyFiles, commands),
  };
}

const FILE_REFERENCE = /(?<![\w/])([\w.-]+(?:\/[\w.-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|h|cpp|hpp|rb|php|swift|json|md|ya?ml|toml|txt|sql))(?::\d+)?/g;

export function extractFileReferences(text: string): string[] {
  const matches = text.matchAll(FILE_REFERENCE);
  return [...new Set([...matches].map((match) => match[1]))].filter(Boolean);
}

export function unknownProjectFiles(text: string, evidence: ProjectEvidence): string[] {
  const known = new Set(evidence.files.map((path) => path.toLowerCase()));
  const knownNames = new Set(evidence.files.map((path) => basename(path).toLowerCase()));
  return extractFileReferences(text).filter((reference) => {
    const lower = reference.toLowerCase();
    if (lower.startsWith("http://") || lower.startsWith("https://")) return false;
    if (known.has(lower) || knownNames.has(basename(lower))) return false;
    return true;
  });
}

export function looksLikeMissingFileAnswer(text: string): boolean {
  return (
    /\b(?:belum|tidak)\s+(?:melihat|membaca|menemukan)\b[\s\S]{0,40}\b(?:isi|konten)\b/i.test(
      text,
    ) ||
    /\b(?:belum|tidak)\s+(?:melihat|membaca)\b[\s\S]{0,40}\bfile\b[\s\S]{0,20}\b(?:yang dimaksud|tersebut|itu)\b/i.test(
      text,
    ) ||
    /\b(?:berikan|kirim|share)\b[\s\S]{0,60}\b(?:isi|konten|file)\b/i.test(text)
  );
}

export function isProjectFileFollowUp(text: string): boolean {
  return /\b(?:file|kode|script|source)\b[\s\S]{0,40}\b(?:tersebut|itu|tadi|sebelumnya|yang tadi|this|that|previous)\b/i.test(
    text,
  );
}
