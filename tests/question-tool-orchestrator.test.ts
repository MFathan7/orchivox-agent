import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

function messageText(message: {
  content: Array<{ type: string; text?: string; content?: string }>;
}): string {
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "tool_result") return block.content ?? "";
      return "";
    })
    .join(" ");
}

class QuestionProvider implements LLMProvider {
  readonly calls: Array<{ tools: string[]; messages: ChatRequest["messages"] }> = [];

  async listModels(): Promise<string[]> {
    return [];
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<StreamEvent, void, unknown> {
    this.calls.push({
      tools: request.tools.map((tool) => tool.name),
      messages: request.messages,
    });

    if (this.calls.length === 1) {
      yield {
        type: "tool_call_ready",
        id: "call-1",
        name: "question",
        arguments: {
          question: "Pick a framework",
          header: "Framework",
          options: [{ label: "A" }, { label: "B" }, { label: "C" }],
          multiple: true,
          allow_custom: true,
        },
      };
      yield { type: "done", finish_reason: "tool_calls" };
      return;
    }

    yield { type: "token", text: "done" };
    yield { type: "done", finish_reason: "stop" };
  }
}

describe("question tool orchestration", () => {
  it("waits for the handler and sends the answer back to the model", async () => {
    const repo = await mkdtemp(join(tmpdir(), "question-tool-"));
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
      const provider = new QuestionProvider();
      router.get = () => provider;
      const database = new MemoryDatabase(":memory:");
      const session = database.createSession({ title: "question", mode: "build" });
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
      orchestrator.setQuestionHandler(async (request) => {
        expect(request.id.startsWith("question-")).toBe(true);
        expect(request.multiple).toBe(true);
        return { selected: ["A", "B"], custom: "Custom C" };
      });

      const request = AgentRunRequestSchema.parse({
        profile: "orchivox-main",
        messages: [
          {
            id: "u1",
            role: "user",
            content: [{ type: "text", text: "ask me a question" }],
          },
        ],
        metadata: { session_id: session.id },
        max_tokens: 256,
      });

      for await (const _event of orchestrator.runStream(request)) {
        // Consume the stream.
      }

      expect(provider.calls.length).toBe(2);
      expect(provider.calls[0].tools).toContain("question");
      const toolResult = provider.calls[1].messages.find((message) => message.role === "tool");
      expect(toolResult).toBeDefined();
      expect(messageText(toolResult!)).toContain("Selected: A, B");
      expect(messageText(toolResult!)).toContain("Custom answer: Custom C");
      database.close();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15000);
});
