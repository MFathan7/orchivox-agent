export const SKILL_ALWAYS_ALLOWED_TOOLS = [
  "skill",
  "skill_list",
  "todo_write",
  "todo_read",
  "read_file",
  "glob_files",
  "grep_search",
  "json_query",
  "diagnostics_check",
] as const;

export class SkillToolPolicy {
  private readonly alwaysAllowed: Set<string>;
  private allowed: Set<string> | undefined;

  constructor(alwaysAllowed: Iterable<string> = SKILL_ALWAYS_ALLOWED_TOOLS) {
    this.alwaysAllowed = new Set(alwaysAllowed);
  }

  activate(allowedTools: readonly string[]): void {
    if (!this.allowed) this.allowed = new Set(this.alwaysAllowed);
    for (const tool of allowedTools) this.allowed.add(tool);
  }

  allows(toolName: string): boolean {
    return this.allowed === undefined || this.allowed.has(toolName);
  }

  filter<T extends { name: string }>(tools: T[]): T[] {
    const allowed = this.allowed;
    return allowed === undefined ? tools : tools.filter((tool) => allowed.has(tool.name));
  }

  get active(): boolean {
    return this.allowed !== undefined;
  }

  get activeTools(): string[] {
    return this.allowed ? [...this.allowed] : [];
  }
}
