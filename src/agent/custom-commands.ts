import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface CustomCommandFrontmatter {
  description?: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
}

export interface CustomCommand {
  name: string;
  filePath: string;
  frontmatter: CustomCommandFrontmatter;
  template: string;
}

export interface ExpandedCustomCommand {
  command: CustomCommand;
  prompt: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
}

const DEFAULT_COMMANDS: Record<string, { frontmatter: CustomCommandFrontmatter; template: string }> = {
  "review.md": {
    frontmatter: {
      description: "Code review perubahan git dengan fokus keamanan, performa, dan edge cases",
      agent: "oracle",
      model: "advisor",
      subtask: false,
    },
    template: `Lakukan review menyeluruh terhadap perubahan kode git berikut ini.
Fokuskan pada:
1. Keamanan dan penanganan input kotor / edge cases
2. Efisiensi algoritma dan potensi bottleneck performa
3. Kepatuhan arsitektur, modularitas, dan prinsip clean code

### Status Git:
\`\`\`
!\`git status -s\`
\`\`\`

### Diff Git:
\`\`\`
!\`git diff HEAD\`
\`\`\`

Instruksi tambahan pengguna:
$ARGUMENTS`,
  },
  "fix-tests.md": {
    frontmatter: {
      description: "Jalankan test suite, analisis kegagalan, dan perbaiki kode yang rusak",
      agent: "sisyphus",
      model: "main",
      subtask: false,
    },
    template: `Jalankan test suite dan selesaikan seluruh kegagalan pengujian sampai semua test lulus 100%.

### Hasil Test Saat Ini:
\`\`\`
!\`bun test\`
\`\`\`

Instruksi tambahan:
$ARGUMENTS`,
  },
  "refactor.md": {
    frontmatter: {
      description: "Refaktor kode untuk meningkatkan modularitas, keterbacaan, dan konsistensi",
      agent: "oracle",
      model: "advisor",
      subtask: false,
    },
    template: `Analisis dan lakukan refactoring terstruktur pada target berkas atau modul berikut:
Target: $1
Fokus: $ARGUMENTS

Pedoman:
1. Jangan merusak antarmuka publik atau perilaku yang sudah ada.
2. Jaga kebersihan arsitektur dan hapus kode usang atau duplikasi.
3. Pastikan kode tetap lulus pengujian dan typecheck.`,
  },
  "init-rules.md": {
    frontmatter: {
      description: "Analisis dependensi dan struktur proyek lalu inisialisasi aturan agen di .agent/rules/",
      agent: "librarian",
      model: "main",
      subtask: false,
    },
    template: `Analisis struktur proyek, dependensi, dan konvensi kode di repositori ini.
Buat atau perbarui file aturan arsitektur di direktori \`.agent/rules/\`.

Detail tambahan:
$ARGUMENTS`,
  },
};

export function parseArgumentsList(args: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(args)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

export function parseFrontmatter(rawContent: string): { frontmatter: CustomCommandFrontmatter; template: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(rawContent);
  if (!match) {
    return { frontmatter: {}, template: rawContent.trim() };
  }

  try {
    const parsed = parseYaml(match[1]) as Record<string, unknown> | null;
    const frontmatter: CustomCommandFrontmatter = {
      description: typeof parsed?.description === "string" ? parsed.description : undefined,
      agent: typeof parsed?.agent === "string" ? parsed.agent : undefined,
      model: typeof parsed?.model === "string" ? parsed.model : undefined,
      subtask: typeof parsed?.subtask === "boolean" ? parsed.subtask : undefined,
    };
    return { frontmatter, template: match[2].trim() };
  } catch {
    return { frontmatter: {}, template: rawContent.trim() };
  }
}

export class CustomCommandEngine {
  private readonly repoRoot: string;
  private readonly commandsDir: string;
  private cachedCommands = new Map<string, CustomCommand>();

  constructor(options?: { repoRoot?: string }) {
    this.repoRoot = options?.repoRoot ?? globalThis.process.cwd();
    this.commandsDir = resolve(this.repoRoot, ".agent", "commands");
  }

  async ensureDefaults(): Promise<void> {
    if (!existsSync(this.commandsDir)) {
      await mkdir(this.commandsDir, { recursive: true });
    }

    for (const [filename, def] of Object.entries(DEFAULT_COMMANDS)) {
      const filePath = resolve(this.commandsDir, filename);
      if (!existsSync(filePath)) {
        const frontmatterLines = [
          "---",
          def.frontmatter.description ? `description: ${def.frontmatter.description}` : "",
          def.frontmatter.agent ? `agent: ${def.frontmatter.agent}` : "",
          def.frontmatter.model ? `model: ${def.frontmatter.model}` : "",
          def.frontmatter.subtask !== undefined ? `subtask: ${def.frontmatter.subtask}` : "",
          "---",
        ].filter(Boolean);

        const content = `${frontmatterLines.join("\n")}\n${def.template}\n`;
        await writeFile(filePath, content, "utf8");
      }
    }
  }

  async loadCommands(): Promise<Map<string, CustomCommand>> {
    await this.ensureDefaults();
    const map = new Map<string, CustomCommand>();

    try {
      const entries = await readdir(this.commandsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const name = entry.name.slice(0, -3);
        const filePath = resolve(this.commandsDir, entry.name);
        const raw = await readFile(filePath, "utf8");
        const { frontmatter, template } = parseFrontmatter(raw);
        map.set(name, {
          name,
          filePath,
          frontmatter,
          template,
        });
      }
    } catch {
      // Return currently loaded map if directory read fails.
    }

    this.cachedCommands = map;
    return map;
  }

  async listCommands(): Promise<CustomCommand[]> {
    const map = await this.loadCommands();
    return Array.from(map.values());
  }

  async getCommand(name: string): Promise<CustomCommand | undefined> {
    const cleanName = name.startsWith("/") ? name.slice(1) : name;
    if (this.cachedCommands.size === 0) {
      await this.loadCommands();
    }
    return this.cachedCommands.get(cleanName);
  }

  async expandTemplate(template: string, rawArgs: string): Promise<string> {
    const tokens = parseArgumentsList(rawArgs);
    let result = template;

    result = result.replace(/\$ARGUMENTS\b/g, rawArgs.trim());
    result = result.replace(/\$@\b/g, rawArgs.trim());

    for (let index = 1; index <= 9; index += 1) {
      const token = tokens[index - 1] ?? "";
      const regex = new RegExp(`\\$${index}\\b`, "g");
      result = result.replace(regex, token);
    }

    const inlineShellRegex = /!`([^`]+)`/g;
    const shellMatches = [...result.matchAll(inlineShellRegex)];

    for (const match of shellMatches) {
      const fullMatch = match[0];
      const shellCmd = match[1];
      const output = await this.executeInlineShell(shellCmd);
      result = result.replace(fullMatch, output);
    }

    const fileRefRegex = /@([a-zA-Z0-9_./-]+(?::L?\d+(?:-\d+)?)?)/g;
    const fileMatches = [...result.matchAll(fileRefRegex)];

    for (const match of fileMatches) {
      const fullMatch = match[0];
      const target = match[1];

      const expanded = await this.tryExpandFileReference(target);
      if (expanded !== null) {
        result = result.replace(fullMatch, expanded);
      }
    }

    return result;
  }

  async executeCommand(name: string, rawArgs: string): Promise<ExpandedCustomCommand | undefined> {
    const cmd = await this.getCommand(name);
    if (!cmd) return undefined;

    const expandedPrompt = await this.expandTemplate(cmd.template, rawArgs);

    return {
      command: cmd,
      prompt: expandedPrompt,
      agent: cmd.frontmatter.agent,
      model: cmd.frontmatter.model,
      subtask: cmd.frontmatter.subtask,
    };
  }

  private async executeInlineShell(command: string): Promise<string> {
    try {
      const proc = Bun.spawn(["bash", "-c", command], {
        cwd: this.repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;
      const trimmedOut = stdout.trim();
      const trimmedErr = stderr.trim();

      if (trimmedOut.length > 0) {
        return trimmedOut;
      }
      if (trimmedErr.length > 0) {
        return `[stderr: ${trimmedErr}]`;
      }
      return exitCode === 0 ? "" : `[exit code: ${exitCode}]`;
    } catch (error) {
      return `[shell error: ${error instanceof Error ? error.message : String(error)}]`;
    }
  }

  private async tryExpandFileReference(target: string): Promise<string | null> {
    const colonIndex = target.indexOf(":");
    let filePathPart = target;
    let rangePart: string | undefined;

    if (colonIndex !== -1) {
      filePathPart = target.slice(0, colonIndex);
      rangePart = target.slice(colonIndex + 1);
    }

    if (!filePathPart.includes("/") && !filePathPart.includes(".")) {
      return null;
    }

    const fullPath = isAbsolute(filePathPart) ? filePathPart : resolve(this.repoRoot, filePathPart);
    if (!existsSync(fullPath)) {
      return null;
    }

    try {
      const content = await readFile(fullPath, "utf8");
      const lines = content.split("\n");

      if (rangePart) {
        const cleanedRange = rangePart.replace(/^L/i, "");
        const [startStr, endStr] = cleanedRange.split("-");
        const start = Math.max(1, parseInt(startStr, 10) || 1);
        const end = endStr ? Math.min(lines.length, parseInt(endStr, 10)) : start;
        const selectedLines = lines.slice(start - 1, end);
        return [
          `--- File: ${relative(this.repoRoot, fullPath)} (lines ${start}-${end}) ---`,
          selectedLines.join("\n"),
          "--- End of File Excerpt ---",
        ].join("\n");
      }

      return [
        `--- File: ${relative(this.repoRoot, fullPath)} ---`,
        content.trimEnd(),
        "--- End of File ---",
      ].join("\n");
    } catch {
      return null;
    }
  }
}
