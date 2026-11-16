export const SKILL_ALWAYS_ALLOWED_TOOLS = [
  "skill",
  "skill_list",
  "todo_write",
  "todo_read",
  "read_file",
  "read_document",
  "read_database",
  "ast_search",
  "code_find",
  "read_archive",
  "read_notebook",
  "glob_files",
  "grep_search",
  "json_query",
  "diagnostics_check",
] as const;

export class SkillToolPolicy {
  private readonly alwaysAllowed: Set<string>;
  private allowed: Set<string> | undefined;
  private readonly patterns: RegExp[] = [];

  constructor(alwaysAllowed: Iterable<string> = SKILL_ALWAYS_ALLOWED_TOOLS) {
    this.alwaysAllowed = new Set(alwaysAllowed);
  }

  activate(allowedTools: readonly string[]): void {
    if (!this.allowed) this.allowed = new Set(this.alwaysAllowed);
    for (const tool of allowedTools) {
      if (this.allowed.has(tool)) continue;
      this.allowed.add(tool);
      if (tool.includes("*")) {
        const escaped = tool.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
        this.patterns.push(new RegExp(`^${escaped}$`));
      }
    }
  }

  allows(toolName: string): boolean {
    return this.allowed === undefined || this.allowed.has(toolName) || this.patterns.some((pattern) => pattern.test(toolName));
  }

  filter<T extends { name: string }>(tools: T[]): T[] {
    return tools.filter((tool) => this.allows(tool.name));
  }

  get active(): boolean {
    return this.allowed !== undefined;
  }

  get activeTools(): string[] {
    return this.allowed ? [...this.allowed] : [];
  }
}
