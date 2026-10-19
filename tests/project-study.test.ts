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

async function makeProject(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "project-study-"));
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
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, ".agent", "agents", "AGENTS.md"),
    "# Agent instructions\n\nFollow the project rules.\n",
  );
  await writeFile(join(repo, "src", "index.ts"), "export const app = 'acme';\n");
  return repo;
}

function messageText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content.map((block) => (block.type === "text" ? block.text ?? "" : "")).join(" ");
}

class StudyProvider implements LLMProvider {
  readonly calls: Array<{
    system: string;
    tools: string[];
    toolChoice: string;
    messages: ChatRequest["messages"];
  }> = [];

  constructor(private readonly repo: string) {}

  async listModels(): Promise<string[]> {
    return [];
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<StreamEvent, void, unknown> {
    this.calls.push({
      system: request.system ?? "",
      tools: request.tools.map((tool) => tool.name),
      toolChoice: request.tool_choice,
      messages: request.messages,
    });

    if (this.calls.length === 1) {
      yield {
        type: "tool_call_ready",
        id: "call-1",
        name: "read_file",
        arguments: { filePath: join(this.repo, "package.json") },
      };
      yield { type: "done", finish_reason: "tool_calls" };
      return;
    }

    if (this.calls.length === 2) {
      yield {
        type: "token",
        text: "I've inspected the environment. How can I help you today?",
      };
      yield { type: "done", finish_reason: "stop" };
      return;
    }

    yield {
      type: "token",
      text:
        "Acme is a personal coding agent runtime. It has a src module and tests. Run bun test to verify.",
    };
    yield { type: "done", finish_reason: "stop" };
  }
}

describe("project study answer enforcement", () => {
  it("turns a greeting after tool calls into a project report", async () => {
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
      const provider = new StudyProvider(repo);
      router.get = () => provider;
      const database = new MemoryDatabase(":memory:");
      const session = database.createSession({ title: "project study", mode: "build" });
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
            content: [{ type: "text", text: "Coba kamu pelajari project saat ini" }],
          },
        ],
        metadata: { session_id: session.id },
        max_tokens: 512,
      });

      const tokens: string[] = [];
      for await (const event of orchestrator.runStream(request)) {
        if (event.type === "token") tokens.push(event.text);
      }

      expect(provider.calls.length).toBe(3);
      expect(provider.calls[0].system).toContain("# Project study");
      expect(provider.calls[0].tools).toContain("read_file");
      expect(provider.calls[0].tools).not.toContain("web_search");
      expect(
        provider.calls[1].messages.some(
          (message) => message.role === "user" && messageText(message).includes("write the project report"),
        ),
      ).toBe(true);
      expect(provider.calls[2].toolChoice).toBe("none");
      expect(provider.calls[2].system).toContain("# Project");
      expect(
        provider.calls[2].messages.some((message) =>
          messageText(message).includes("How can I help you today?"),
        ),
      ).toBe(false);

      const answer = tokens.join("");
      expect(answer).toContain("Acme is a personal coding agent runtime");
      expect(answer).not.toContain("How can I help you today?");
      database.close();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15000);
});
