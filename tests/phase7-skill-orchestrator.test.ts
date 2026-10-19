import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentOrchestrator } from "../src/agent/orchestrator";
import { GranularPermissionEngine } from "../src/agent/permissions";
import { AgentRunRequestSchema } from "../src/api/server";
import { parseConfig } from "../src/config/loader";
import { RulesLoader } from "../src/memory/rules-loader";
import { MemoryDatabase } from "../src/memory/sqlite";
import { ProviderRouter, type LLMProvider } from "../src/provider/router";
import type { ChatRequest, StreamEvent } from "../src/types/schema";
import { SnapshotManager } from "../src/vcs/snapshot";
import { WorktreeManager } from "../src/vcs/worktree";

class ScriptedProvider implements LLMProvider {
  readonly calls: string[][] = [];
  readonly systems: string[] = [];
  private turn = 0;

  async listModels(): Promise<string[]> {
    return [];
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<StreamEvent, void, unknown> {
    this.turn += 1;
    this.calls.push(request.tools.map((tool) => tool.name));
    this.systems.push(request.system ?? "");
    if (this.turn === 1) {
      yield {
        type: "tool_call_ready",
        id: "call-skill",
        name: "skill",
        arguments: { id: "pdf" },
      };
      yield { type: "done", finish_reason: "tool_calls" };
      return;
    }
    yield { type: "token", text: "done" };
    yield { type: "done", finish_reason: "stop" };
  }
}

class TextOnlyProvider implements LLMProvider {
  readonly systems: string[] = [];

  async listModels(): Promise<string[]> {
    return [];
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<StreamEvent, void, unknown> {
    this.systems.push(request.system ?? "");
    yield { type: "token", text: "ok" };
    yield { type: "done", finish_reason: "stop" };
  }
}

describe("Skill policy in the orchestrator", () => {
  it("removes disallowed tools after a skill is loaded", async () => {
    const repo = await mkdtemp(join(tmpdir(), "orchivox-skill-policy-"));
    try {
      await mkdir(join(repo, ".agent", "skills", "pdf"), { recursive: true });
      await writeFile(
        join(repo, ".agent", "skills", "pdf", "SKILL.md"),
        [
          "---",
          "name: pdf",
          "description: Read PDF files.",
          "allowed_tools:",
          "  - read_file",
          "---",
          "",
          "# PDF",
          "",
          "Read the file.",
          "",
        ].join("\n"),
      );

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
      const provider = new ScriptedProvider();
      router.get = () => provider;

      const database = new MemoryDatabase(":memory:");
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
      expect(orchestrator.registry.has("web_search")).toBe(true);
      expect(orchestrator.registry.has("web_fetch")).toBe(true);
      database.createSession({ id: "sess-skill", title: "skill policy", mode: "build" });

      const result = await orchestrator.runOnce(
        AgentRunRequestSchema.parse({
          profile: "orchivox-main",
          messages: [
            {
              id: "u1",
              role: "user",
              content: [{ type: "text", text: "Read the attached document." }],
            },
          ],
          metadata: { session_id: "sess-skill" },
          max_tokens: 128,
        }),
      );

      expect(result.message).toBeDefined();
      expect(provider.calls).toHaveLength(2);
      expect(provider.calls[0]).toContain("hash_edit");
      expect(provider.calls[1]).toContain("read_file");
      expect(provider.calls[1]).toContain("skill");
      expect(provider.calls[1]).toContain("todo_write");
      expect(provider.calls[1]).not.toContain("hash_edit");
      expect(provider.calls[1]).not.toContain("spawn_subagents");
      expect(provider.systems[0]).toContain("<available_skills>");
      expect(provider.systems[0]).toContain("<id>pdf</id>");
      expect(provider.systems[1]).toContain("# Active skills");
      expect(provider.systems[1]).toContain('<skill_content name="pdf">');
      expect(database.listSessionSkills("sess-skill").map((skill) => skill.name)).toEqual(["pdf"]);

      const textProvider = new TextOnlyProvider();
      router.get = () => textProvider;
      await orchestrator.runOnce(
        AgentRunRequestSchema.parse({
          profile: "orchivox-main",
          messages: [
            {
              id: "u2",
              role: "user",
              content: [{ type: "text", text: "What should we do next?" }],
            },
          ],
          metadata: { session_id: "sess-skill" },
          max_tokens: 128,
        }),
      );
      expect(textProvider.systems[0]).toContain("# Active skills");
      expect(textProvider.systems[0]).toContain('<skill_content name="pdf">');
      expect(orchestrator.getLastPromptInfo("sess-skill")?.activeSkills).toEqual(["pdf"]);
      database.close();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15000);
});
