import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentOrchestrator } from "../src/agent/orchestrator";
import { GranularPermissionEngine } from "../src/agent/permissions";
import {
  isCapabilityQuestion,
  isProjectIdentityQuestion,
  isProjectQuestion,
  isProjectStudyRequest,
  loadProjectContext,
  looksLikeNonAnswer,
} from "../src/agent/project-context";
import { AgentRunRequestSchema } from "../src/api/server";
import { parseConfig } from "../src/config/loader";
import { RulesLoader } from "../src/memory/rules-loader";
import { MemoryDatabase } from "../src/memory/sqlite";
import { ProviderRouter, type LLMProvider } from "../src/provider/router";
import type { ChatRequest, StreamEvent } from "../src/types/schema";
import { SnapshotManager } from "../src/vcs/snapshot";
import { WorktreeManager } from "../src/vcs/worktree";

async function makeProject(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "project-context-"));
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      name: "acme-agent",
      description: "Acme personal coding agent.",
    }),
  );
  await writeFile(
    join(repo, "README.md"),
    "# Acme\n\nAcme helps teams ship focused coding work.\n",
  );
  await writeFile(join(repo, "AGENTS.md"), "Project directive: `.agent/agents/AGENTS.md`.\n");
  await mkdir(join(repo, ".agent", "agents"), { recursive: true });
  await writeFile(
    join(repo, ".agent", "agents", "AGENTS.md"),
    [
      "## 1. Project Identity & Core Pillars",
      "",
      "Acme is a personal coding agent runtime that keeps work focused.",
      "",
      "## 2. Quick Commands",
      "",
      "Run `acme start`.",
      "",
    ].join("\n"),
  );
  return repo;
}

class CaptureProvider implements LLMProvider {
  readonly systems: string[] = [];
  readonly tools: string[][] = [];
  readonly toolChoices: string[] = [];

  async listModels(): Promise<string[]> {
    return [];
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<StreamEvent, void, unknown> {
    this.systems.push(request.system ?? "");
    this.tools.push(request.tools.map((tool) => tool.name));
    this.toolChoices.push(request.tool_choice);
    yield { type: "token", text: "ok" };
    yield { type: "done", finish_reason: "stop" };
  }
}

describe("project context", () => {
  it("derives project details from the repository without hardcoded names", async () => {
    const repo = await makeProject();
    try {
      const context = await loadProjectContext(repo);
      expect(context.name).toBe("acme-agent");
      expect(context.description).toContain("Acme personal coding agent");
      expect(context.summary).toContain("acme-agent");
      expect(context.summary).toContain("Acme is a personal coding agent runtime");
      expect(context.summary).toContain(".agent/agents/AGENTS.md");
      expect(context.summary).not.toContain("orchivox");
      expect(context.aliases).toContain("acme");
      expect(context.aliases).toContain("acme-agent");
      expect(isProjectQuestion("what is acme-agent?", context)).toBe(true);
      expect(isProjectQuestion("what is this project?", context)).toBe(true);
      expect(isProjectQuestion("Coba kamu pelajari project saat ini", context)).toBe(true);
      expect(isProjectQuestion("write a function", context)).toBe(false);
      expect(isProjectStudyRequest("Coba kamu pelajari project saat ini")).toBe(true);
      expect(isProjectStudyRequest("study the codebase and report back")).toBe(true);
      expect(isProjectStudyRequest("write a function")).toBe(false);
      expect(isProjectIdentityQuestion("apa itu acme-agent?", context)).toBe(true);
      expect(isProjectIdentityQuestion("what is this project?", context)).toBe(true);
      expect(isProjectIdentityQuestion("how does auth work in this project?", context)).toBe(false);
      expect(isCapabilityQuestion("bisa apa?")).toBe(true);
      expect(isCapabilityQuestion("what can you do?")).toBe(true);
      expect(isCapabilityQuestion("apa itu acme-agent?")).toBe(false);
      expect(looksLikeNonAnswer("I've inspected the environment. How can I help you today?", context)).toBe(true);
      expect(
        looksLikeNonAnswer(
          "The user wants me to study the project. Plan: 1. List files. 2. Read package.json.",
          context,
          { requireProjectMention: true },
        ),
      ).toBe(true);
      expect(
        looksLikeNonAnswer(
          "The user wants a project report for acme-agent. Plan: 1. Read package.json.",
          context,
          { requireProjectMention: true },
        ),
      ).toBe(true);
      expect(looksLikeNonAnswer("Acme is a personal coding agent runtime with focused tools and tests.", context)).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("loads the directive referenced by AGENTS.md", async () => {
    const repo = await makeProject();
    try {
      const rules = new RulesLoader({ rootPath: repo });
      const global = await rules.getGlobalRules();
      expect(global).toContain("Acme is a personal coding agent runtime");
      expect(global).toContain("Project directive");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("guards web tools and injects the project hint for project questions", async () => {
    const repo = await makeProject();
    try {
      const config = parseConfig({
        providers: {
          fake: {
            kind: "openai",
            base_url: "http://127.0.0.1:1/v1",
            models: ["gpt-4o"],
            model_capabilities: { "gpt-4o": { vision: false } },
          },
        },
        roles: { main_model: { provider: "fake", model: "gpt-4o" } },
      });
      const router = new ProviderRouter(config);
      const provider = new CaptureProvider();
      router.get = () => provider;
      const database = new MemoryDatabase(":memory:");
      const session = database.createSession({ title: "project question", mode: "build" });
      const orchestrator = new AgentOrchestrator({
        router,
        worktrees: new WorktreeManager({ repoRoot: repo }),
        snapshots: new SnapshotManager({ repoRoot: repo }),
        rules: new RulesLoader({ rootPath: repo }),
        database,
        config,
        permissions: new GranularPermissionEngine({ repoRoot: repo }),
        repoRoot: repo,
      });
      await orchestrator.initialize();

      const request = AgentRunRequestSchema.parse({
        profile: "orchivox-main",
        messages: [
          {
            id: "u1",
            role: "user",
            content: [{ type: "text", text: "what is this project?" }],
          },
        ],
        metadata: { session_id: session.id },
        max_tokens: 128,
      });
      for await (const _event of orchestrator.runStream(request)) {
        // consume the stream
      }

      expect(provider.systems[0]).toContain("# Project");
      expect(provider.systems[0]).toContain("acme-agent");
      expect(provider.systems[0]).toContain("Acme is a personal coding agent runtime");
      expect(provider.systems[0]).toContain("# Project question");
      expect(provider.systems[0]).toContain("answer it directly");
      expect(provider.tools[0]).toEqual([]);
      expect(provider.toolChoices[0]).toBe("none");
      expect(provider.tools[0]).not.toContain("web_search");
      expect(provider.tools[0]).not.toContain("web_fetch");
      database.close();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15000);
});
