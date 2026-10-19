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

class CaptureProvider implements LLMProvider {
  readonly systems: string[] = [];
  readonly tools: string[][] = [];

  async listModels(): Promise<string[]> {
    return [];
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<StreamEvent, void, unknown> {
    this.systems.push(request.system ?? "");
    this.tools.push(request.tools.map((tool) => tool.name));
    yield { type: "token", text: "ok" };
    yield { type: "done", finish_reason: "stop" };
  }
}

describe("skill auto activation", () => {
  it("loads a skill named in the request and hides web tools on the first turn", async () => {
    const repo = await mkdtemp(join(tmpdir(), "orchivox-skill-auto-"));
    try {
      await mkdir(join(repo, ".agent", "skills", "archify"), { recursive: true });
      await writeFile(
        join(repo, ".agent", "skills", "archify", "SKILL.md"),
        [
          "---",
          "name: archify",
          "description: Create architecture diagrams.",
          "---",
          "",
          "# Archify",
          "",
          "Use this skill for architecture diagrams.",
          "",
        ].join("\n"),
      );

      const config = parseConfig({
        providers: {
          fake: {
            kind: "ollama",
            base_url: "http://127.0.0.1:1/v1",
            models: ["qwen3.5:9b"],
            model_capabilities: { "qwen3.5:9b": { vision: false } },
          },
        },
        roles: { main_model: { provider: "fake", model: "qwen3.5:9b" } },
      });
      const router = new ProviderRouter(config);
      const provider = new CaptureProvider();
      router.get = () => provider;

      const database = new MemoryDatabase(":memory:");
      const session = database.createSession({ title: "auto skill", mode: "build" });
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
            content: [{ type: "text", text: "Coba carikan informasi tentang archify" }],
          },
        ],
        metadata: { session_id: session.id },
        max_tokens: 128,
      });

      const activated: Array<{ name: string; trigger?: string }> = [];
      for await (const event of orchestrator.runStream(request)) {
        if (event.type === "skill_activated") {
          activated.push({ name: event.name, trigger: event.trigger });
        }
      }

      expect(activated).toEqual([{ name: "archify", trigger: "auto" }]);
      expect(provider.systems[0]).toContain("# Active skills");
      expect(provider.systems[0]).toContain('<skill_content name="archify">');
      expect(provider.tools[0]).not.toContain("web_search");
      expect(provider.tools[0]).not.toContain("web_fetch");
      expect(database.listSessionSkills(session.id).map((skill) => skill.name)).toEqual(["archify"]);
      database.close();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15000);
});
