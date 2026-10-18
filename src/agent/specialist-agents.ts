import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import type { ToolDefinition } from "../types/schema";

export type SpecialistAgentRoleModel = "main" | "advisor" | "fast" | string;

export interface SpecialistAgentProfile {
  name: string;
  description: string;
  roleModel?: SpecialistAgentRoleModel;
  readOnly?: boolean;
  thinkingBudget?: number;
  allowedTools?: string[];
  systemPrompt: string;
  source: "builtin" | "custom";
}

export interface SpecialistMention {
  agentName: string;
  query: string;
  profile?: SpecialistAgentProfile;
}

export const BUILTIN_SPECIALISTS: Record<string, Omit<SpecialistAgentProfile, "source">> = {
  sisyphus: {
    name: "sisyphus",
    description: "Primary orchestrator leading execution, verifying results with tests & LSP, and tracking todos to 100% completion.",
    roleModel: "main",
    readOnly: false,
    systemPrompt: `You are Sisyphus, the relentless Primary Orchestrator.
Your goal is to drive tasks to 100% completion without giving up.
Key behaviors:
1. Maintain rigorous task tracking using todo tools when in ultrawork mode.
2. Verify every code modification using tests, typechecks, or LSP diagnostics before declaring completion.
3. Delegate independent sub-problems to specialist subagents when appropriate.
4. Never leave placeholders or unfinished code.`,
  },
  oracle: {
    name: "oracle",
    description: "Principal architect & debugger for deep architectural analysis, design trade-offs, and root-cause debugging.",
    roleModel: "advisor",
    readOnly: true,
    thinkingBudget: 16000,
    allowedTools: [
      "read_file",
      "glob_files",
      "grep_search",
      "diff_view",
      "json_query",
      "ast_search",
      "ast_declarations",
      "lsp_diagnostics",
      "lsp_references",
      "lsp_definition",
    ],
    systemPrompt: `You are Oracle, the Principal Software Architect and Deep Reasoning Specialist.
Your mission is to provide rigorous, high-clarity architectural guidance, uncover subtle edge cases, evaluate design trade-offs, and conduct exhaustive root-cause analysis for complex bugs.
Key principles:
1. First-principles analysis: Never assume. Examine the codebase, verify invariants, and validate assumptions against real code and git history.
2. Read-only discipline: You inspect, diagnose, and prescribe solutions with precision without making direct speculative edits.
3. Systemic thinking: Consider upstream inputs, downstream consumers, error domains, latency, memory footprints, and concurrency hazards.
4. Actionable recommendations: When identifying issues, present concrete, minimal, and robust implementation plans with exact file paths and reasoning.`,
  },
  librarian: {
    name: "librarian",
    description: "Documentation and research specialist for external libraries, GitHub repositories, and papers using web search and fetch.",
    roleModel: "fast",
    readOnly: true,
    allowedTools: ["read_file", "glob_files", "grep_search", "web_search", "web_fetch", "json_query"],
    systemPrompt: `You are Librarian, the Documentation, Open Source, and Research Specialist.
Your expertise lies in researching documentation, analyzing third-party libraries, reading GitHub repositories, and breaking down technical specifications and research papers.
Key principles:
1. Grounded synthesis: Base findings strictly on official documentation, canonical source repositories, or verified references.
2. Concise extraction: Distill API signatures, breaking changes, and configuration semantics clearly.
3. Reference preservation: Provide clear citations and source links for every finding.`,
  },
  explore: {
    name: "explore",
    description: "Fast codebase scout for rapid parallel scanning with glob_files, grep_search, and read_skeleton without modifying files.",
    roleModel: "fast",
    readOnly: true,
    allowedTools: [
      "glob_files",
      "grep_search",
      "read_file",
      "diff_view",
      "json_query",
      "ast_declarations",
      "ast_search",
    ],
    systemPrompt: `You are Explore, the Fast Codebase Scout.
Your specialty is ultra-fast exploration and indexing of codebases.
Key principles:
1. Speed and breadth: Rapidly scan project trees, find symbol occurrences, and map architectural boundaries.
2. Read-only safety: You never modify files or run destructive shell operations.
3. High signal summaries: Return structured file maps, symbol locations, and concise excerpts rather than dumping whole files.`,
  },
  "frontend-ui": {
    name: "frontend-ui",
    description: "User interface specialist for precise layouts, terminal components, and accessibility.",
    roleModel: "main",
    readOnly: false,
    systemPrompt: `You are Frontend-UI, the Specialist for User Interfaces, Styling, and Accessibility.
Your focus is building resilient, accessible, clean, and antislop interfaces across terminal TUIs (Ink/React) and web frontends.
Key principles:
1. Antislop design: Avoid generic aesthetics, unnecessary emoji clutter, low-contrast text, and broken keyboard navigation.
2. Layout robustness: Ensure layouts reflow cleanly, handle overflow gracefully, and honor responsive constraints.
3. State and accessibility: Ensure keyboard focus, contrast ratios, and loading/error states are clearly communicated to users.`,
  },
};

export function parseSpecialistMention(
  text: string,
  knownAgents?: string[],
): SpecialistMention | null {
  const trimmed = text.trim();
  const match = /^@([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;

  const candidate = match[1].toLowerCase();
  if (knownAgents && !knownAgents.includes(candidate)) {
    return null;
  }

  return {
    agentName: candidate,
    query: (match[2] ?? "").trim(),
  };
}

export class SpecialistAgentRegistry {
  private readonly repoRoot: string;
  private readonly agentsDir: string;
  private cachedAgents = new Map<string, SpecialistAgentProfile>();

  constructor(options?: { repoRoot?: string }) {
    this.repoRoot = options?.repoRoot ?? globalThis.process.cwd();
    this.agentsDir = resolve(this.repoRoot, ".agent", "agents");
  }

  async ensureDefaults(): Promise<void> {
    if (!existsSync(this.agentsDir)) {
      await mkdir(this.agentsDir, { recursive: true });
    }

    const oracleFile = resolve(this.agentsDir, "oracle.md");
    if (!existsSync(oracleFile)) {
      const def = BUILTIN_SPECIALISTS.oracle;
      const content = [
        "---",
        `name: ${def.name}`,
        `description: ${def.description}`,
        `roleModel: ${def.roleModel ?? "advisor"}`,
        `readOnly: ${def.readOnly ?? true}`,
        `thinkingBudget: ${def.thinkingBudget ?? 16000}`,
        "---",
        def.systemPrompt,
      ].join("\n");
      await writeFile(oracleFile, `${content}\n`, "utf8");
    }
  }

  async loadAgents(): Promise<Map<string, SpecialistAgentProfile>> {
    await this.ensureDefaults();
    const map = new Map<string, SpecialistAgentProfile>();

    for (const [name, profile] of Object.entries(BUILTIN_SPECIALISTS)) {
      map.set(name, { ...profile, source: "builtin" });
    }

    try {
      const entries = await readdir(this.agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const filePath = resolve(this.agentsDir, entry.name);
        const raw = await readFile(filePath, "utf8");
        const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
        if (!match) continue;

        try {
          const parsed = parseYaml(match[1]) as Record<string, unknown> | null;
          const name = typeof parsed?.name === "string" ? parsed.name : entry.name.slice(0, -3);
          const description =
            typeof parsed?.description === "string" ? parsed.description : `Specialist agent ${name}`;
          const roleModel = typeof parsed?.roleModel === "string" ? parsed.roleModel : "main";
          const readOnly = typeof parsed?.readOnly === "boolean" ? parsed.readOnly : false;
          const thinkingBudget =
            typeof parsed?.thinkingBudget === "number" ? parsed.thinkingBudget : undefined;
          const allowedTools = Array.isArray(parsed?.allowedTools)
            ? parsed.allowedTools.map(String)
            : undefined;
          const systemPrompt = match[2].trim();

          map.set(name, {
            name,
            description,
            roleModel,
            readOnly,
            thinkingBudget,
            allowedTools,
            systemPrompt,
            source: "custom",
          });
        } catch {
          // Skip invalid custom agent definition files.
        }
      }
    } catch {
      // Return builtin profiles if directory read fails.
    }

    this.cachedAgents = map;
    return map;
  }

  async listAgents(): Promise<SpecialistAgentProfile[]> {
    const map = await this.loadAgents();
    return Array.from(map.values());
  }

  async getAgent(name: string): Promise<SpecialistAgentProfile | undefined> {
    const clean = name.startsWith("@") ? name.slice(1).toLowerCase() : name.toLowerCase();
    if (this.cachedAgents.size === 0) {
      await this.loadAgents();
    }
    return this.cachedAgents.get(clean);
  }

  async parseMention(text: string): Promise<SpecialistMention | null> {
    const agents = await this.listAgents();
    const knownNames = agents.map((agent) => agent.name.toLowerCase());
    const mention = parseSpecialistMention(text, knownNames);
    if (!mention) return null;

    const profile = await this.getAgent(mention.agentName);
    return {
      ...mention,
      profile,
    };
  }

  filterTools(
    agent: SpecialistAgentProfile,
    tools: ToolDefinition[],
    readOnlyToolNames?: ReadonlySet<string>,
  ): ToolDefinition[] {
    let filtered = tools;
    const alwaysAllowed = new Set(["skill", "skill_list"]);

    if (agent.allowedTools && agent.allowedTools.length > 0) {
      const allowedSet = new Set([...agent.allowedTools, ...alwaysAllowed]);
      filtered = filtered.filter((tool) => allowedSet.has(tool.name));
    }

    if (agent.readOnly) {
      if (readOnlyToolNames) {
        filtered = filtered.filter((tool) => readOnlyToolNames.has(tool.name));
      } else {
        const mutatingToolNames = new Set([
          "hash_edit",
          "create_file",
          "delete_file",
          "move_file",
          "apply_unified_patch",
          "shell_execute",
          "bash",
          "bg_start",
          "bg_stop",
          "todo_write",
          "spawn_subagents",
          "task_create",
          "task_dispatch",
          "task_cancel",
          "task_merge",
          "task_wait",
        ]);
        filtered = filtered.filter((tool) => !mutatingToolNames.has(tool.name));
      }
    }

    return filtered;
  }
}
