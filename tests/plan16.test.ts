import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  CustomCommandEngine,
  parseArgumentsList,
  parseFrontmatter,
} from "../src/agent/custom-commands";
import {
  BUILTIN_SPECIALISTS,
  SpecialistAgentRegistry,
  parseSpecialistMention,
} from "../src/agent/specialist-agents";
import { SubagentManager } from "../src/agent/subagent";
import { fetchSlashCommands, fetchSpecialistAgents, invalidateAutocompleteCaches } from "../src/tui/autocomplete";
import { WorktreeManager } from "../src/vcs/worktree";

describe("Custom Markdown Slash Commands Engine", () => {
  it("parses argument list with quotes and individual words correctly", () => {
    const args = 'src/agent/ "my complex task" --verbose';
    const tokens = parseArgumentsList(args);
    expect(tokens).toEqual(["src/agent/", "my complex task", "--verbose"]);
  });

  it("parses YAML frontmatter and template body", () => {
    const raw = `---
description: Run code review
agent: oracle
model: advisor
subtask: false
---
Review this diff:
!\`git diff\`
$ARGUMENTS`;

    const { frontmatter, template } = parseFrontmatter(raw);
    expect(frontmatter.description).toBe("Run code review");
    expect(frontmatter.agent).toBe("oracle");
    expect(frontmatter.model).toBe("advisor");
    expect(frontmatter.subtask).toBe(false);
    expect(template).toContain("Review this diff:");
    expect(template).toContain("!`git diff`");
    expect(template).toContain("$ARGUMENTS");
  });

  it("ensures default commands exist and loads them", async () => {
    const engine = new CustomCommandEngine();
    await engine.ensureDefaults();
    const commands = await engine.listCommands();

    expect(commands.some((c) => c.name === "review")).toBe(true);
    expect(commands.some((c) => c.name === "fix-tests")).toBe(true);
    expect(commands.some((c) => c.name === "refactor")).toBe(true);
    expect(commands.some((c) => c.name === "init-rules")).toBe(true);

    const reviewCmd = await engine.getCommand("review");
    expect(reviewCmd).toBeDefined();
    expect(reviewCmd?.frontmatter.agent).toBe("oracle");
    expect(reviewCmd?.frontmatter.model).toBe("advisor");
  });

  it("expands dynamic templates with $ARGUMENTS, $1, $2, inline shell, and file references", async () => {
    const engine = new CustomCommandEngine();
    const template = `Echo: !\`echo "hello from shell"\`
Target: $1
All args: $ARGUMENTS
File content:
@package.json:1-3`;

    const expanded = await engine.expandTemplate(template, "src/agent/ something-else");

    expect(expanded).toContain("Echo: hello from shell");
    expect(expanded).toContain("Target: src/agent/");
    expect(expanded).toContain("All args: src/agent/ something-else");
    expect(expanded).toContain("--- File: package.json (lines 1-3) ---");
    expect(expanded).toContain('"name": "orchivox-agent"');
  });
});

describe("Named Specialist Agents Engine", () => {
  it("provides 5 builtin specialist agents with correct role models and attributes", async () => {
    const registry = new SpecialistAgentRegistry();
    const agents = await registry.listAgents();

    const names = agents.map((a) => a.name);
    expect(names).toContain("sisyphus");
    expect(names).toContain("oracle");
    expect(names).toContain("librarian");
    expect(names).toContain("explore");
    expect(names).toContain("frontend-ui");

    const oracle = await registry.getAgent("oracle");
    expect(oracle).toBeDefined();
    expect(oracle?.roleModel).toBe("advisor");
    expect(oracle?.readOnly).toBe(true);
    expect(oracle?.thinkingBudget).toBe(16000);

    const explore = await registry.getAgent("explore");
    expect(explore).toBeDefined();
    expect(explore?.roleModel).toBe("fast");
    expect(explore?.readOnly).toBe(true);

    const sisyphus = await registry.getAgent("sisyphus");
    expect(sisyphus).toBeDefined();
    expect(sisyphus?.roleModel).toBe("main");
    expect(sisyphus?.readOnly).toBe(false);
  });

  it("parses specialist mentions from user prompt correctly", async () => {
    const registry = new SpecialistAgentRegistry();

    const mention1 = await registry.parseMention("@oracle jelaskan arsitektur ini");
    expect(mention1).not.toBeNull();
    expect(mention1?.agentName).toBe("oracle");
    expect(mention1?.query).toBe("jelaskan arsitektur ini");
    expect(mention1?.profile?.roleModel).toBe("advisor");

    const mention2 = await registry.parseMention("@explore cari semua penggunaan auth middleware");
    expect(mention2).not.toBeNull();
    expect(mention2?.agentName).toBe("explore");
    expect(mention2?.query).toBe("cari semua penggunaan auth middleware");

    const notAnAgent = await registry.parseMention("@src/agent/orchestrator.ts:10-20 cek kode");
    expect(notAnAgent).toBeNull();
  });

  it("filters tools strictly for read-only and restricted specialist agents", async () => {
    const registry = new SpecialistAgentRegistry();
    const oracle = await registry.getAgent("oracle");
    expect(oracle).toBeDefined();

    const mockTools = [
      { name: "read_file", description: "Read file", parameters: {} },
      { name: "glob_files", description: "Glob files", parameters: {} },
      { name: "hash_edit", description: "Edit file", parameters: {} },
      { name: "shell_execute", description: "Run shell", parameters: {} },
      { name: "lsp_diagnostics", description: "Diagnostics", parameters: {} },
    ];

    const filtered = registry.filterTools(oracle!, mockTools);
    const toolNames = filtered.map((t) => t.name);

    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("glob_files");
    expect(toolNames).toContain("lsp_diagnostics");
    expect(toolNames).not.toContain("hash_edit");
    expect(toolNames).not.toContain("shell_execute");
  });

  it("supports specialist agents in SubagentManager spawning", async () => {
    const worktrees = new WorktreeManager(resolve(process.cwd(), ".agent/test-worktrees"));
    let capturedAgent: string | undefined;

    const subagents = new SubagentManager({
      worktrees,
      executor: async (input) => {
        capturedAgent = input.agent;
        return { output: `done by ${input.agent ?? "default"}` };
      },
    });

    const worker = subagents.spawnOne({
      agent: "oracle",
      task: "analyze architecture",
      writeIsolation: false,
    });

    expect(worker.agent).toBe("oracle");
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedAgent).toBe("oracle");
  });

  it("integrates custom commands and specialist agents into autocomplete suggestions", async () => {
    invalidateAutocompleteCaches();
    const commands = await fetchSlashCommands();
    expect(commands.some((c) => c.label === "/review")).toBe(true);
    expect(commands.some((c) => c.label === "/fix-tests")).toBe(true);

    const agents = await fetchSpecialistAgents();
    expect(agents.some((a) => a.label === "oracle")).toBe(true);
    expect(agents.some((a) => a.label === "explore")).toBe(true);
  });
});
