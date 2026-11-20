import { expect, test } from "bun:test";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentOrchestrator } from "../src/agent/orchestrator";
import { AppConfigSchema } from "../src/config/loader";
import { RulesLoader } from "../src/memory/rules-loader";
import { MemoryDatabase } from "../src/memory/sqlite";
import { ProviderRouter, type LLMProvider } from "../src/provider/router";
import type { ChatRequest, StreamEvent } from "../src/types/schema";
import { SnapshotManager } from "../src/vcs/snapshot";
import { WorktreeManager } from "../src/vcs/worktree";

async function runWorker(workerSteps: number, toolSteps: number, isolated: boolean) {
  const root = await mkdtemp(join(tmpdir(), "orchivox-worker-budget-"));
  const database = new MemoryDatabase(":memory:");
  const requests: ChatRequest[] = [];
  const model = { provider: "test", model: "reasoning-model" };
  const config = AppConfigSchema.parse({
    providers: { test: { kind: "openai", base_url: "http://127.0.0.1:1", models: [model.model] } },
    roles: { main_model: model, fast_model: model },
    limits: { worker_steps: workerSteps },
  });
  const provider: LLMProvider = {
    async *streamChat(request): AsyncGenerator<StreamEvent> {
      requests.push(request);
      if (requests.length <= toolSteps) {
        yield { type: "tool_call_ready", id: `tool-${requests.length}`, name: "todo_read", arguments: {} };
      } else {
        yield { type: "token", text: "Completed verified work." };
      }
    },
    async listModels() { return [model.model]; },
  };
  const router = new ProviderRouter(config);
  router.provider = () => provider;
  const worktrees = new WorktreeManager({ repoRoot: root, worktreesDir: root });
  let removed = false;
  worktrees.createWorktree = async (id) => worktrees.worktreePath(id);
  worktrees.removeWorktree = async () => { removed = true; return true; };
  const orchestrator = new AgentOrchestrator({
    router, worktrees, database, repoRoot: root, config,
    snapshots: new SnapshotManager({ repoRoot: root, stateDir: root }),
    rules: new RulesLoader({ rootPath: root }),
    workerOutputDir: root,
    workerErrorLogPath: root,
  });
  try {
    const worker = orchestrator.subagents.spawnOne({
      id: "worker-budget", task: "Inspect the assigned scope.", roleModel: "fast",
      mode: isolated ? "build" : "plan", writeIsolation: isolated,
    });
    await orchestrator.subagents.waitForWorkers({ ids: [worker.id], waitFor: "all" });
    return { worker, requests, removed };
  } finally {
    await orchestrator.closeToolRuntimes();
    database.close();
    const output = join(root, "worker-budget.md");
    if (await Bun.file(output).exists()) await unlink(output);
    await rmdir(root);
  }
}

test("a worker warns on its last model step and retains isolated work on budget stop", async () => {
  const { worker, requests, removed } = await runWorker(2, 2, true);
  expect(requests).toHaveLength(2);
  expect(requests[0].messages.some((message) => message.metadata?.synthetic)).toBe(false);
  expect(requests[1].messages.at(-1)?.content).toEqual([
    { type: "text", text: expect.stringContaining("Worker model steps remaining: 1") },
  ]);
  expect(worker.error?.code).toBe("turn_limit_exceeded");
  expect(worker.result?.worktree_path).toBe(worker.worktreePath);
  expect(worker.worktreePath).toBeDefined();
  expect(removed).toBe(false);
});

test("a read-only Fast worker can run beyond 40 steps with the step budget disabled", async () => {
  const { worker, requests } = await runWorker(0, 40, false);
  expect(requests).toHaveLength(41);
  expect(requests.every((request) => request.reasoning_effort === "low")).toBe(true);
  expect(worker.status).toBe("completed");
  expect(worker.result?.output).toBe("Completed verified work.");
});
