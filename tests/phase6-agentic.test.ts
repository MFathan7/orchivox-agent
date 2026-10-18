import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SubagentManager, type SubagentTaskInput } from "../src/agent/subagent";
import { TaskBoard, type TaskSpawnInput, type TaskWorkerOutcome } from "../src/agent/task-board";
import { currentMode, currentTurnContext, runWithTurnContext } from "../src/agent/turn-context";
import { MemoryDatabase } from "../src/memory/sqlite";
import type { WorktreeManager } from "../src/vcs/worktree";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const never = (): Promise<TaskWorkerOutcome> => new Promise<TaskWorkerOutcome>(() => undefined);

describe("Turn context", () => {
  it("isolates modes across concurrent async work", async () => {
    const results = await Promise.all([
      runWithTurnContext({ mode: "plan", sessionId: "s1" }, async () => {
        await delay(15);
        return { mode: currentMode(), session: currentTurnContext()?.sessionId };
      }),
      runWithTurnContext({ mode: "ultrawork", sessionId: "s2" }, async () => {
        await delay(5);
        return { mode: currentMode(), session: currentTurnContext()?.sessionId };
      }),
    ]);

    expect(results[0]).toEqual({ mode: "plan", session: "s1" });
    expect(results[1]).toEqual({ mode: "ultrawork", session: "s2" });
  });

  it("has no context outside a turn", () => {
    expect(currentTurnContext()).toBeUndefined();
  });
});

describe("Subagent mode routing", () => {
  it("uses the turn mode for workers spawned concurrently", async () => {
    const captured: SubagentTaskInput[] = [];
    const manager = new SubagentManager({
      worktrees: {} as unknown as WorktreeManager,
      executor: async (input) => {
        await delay(input.task === "plan" ? 10 : 2);
        captured.push(input);
        return { output: "done" };
      },
    });

    await Promise.all([
      runWithTurnContext({ mode: "plan" }, () => manager.spawn([{ task: "plan", writeIsolation: false }])),
      runWithTurnContext({ mode: "ultrawork" }, () => manager.spawn([{ task: "ultra", writeIsolation: false }])),
    ]);

    expect(captured.find((input) => input.task === "plan")?.mode).toBe("plan");
    expect(captured.find((input) => input.task === "ultra")?.mode).toBe("ultrawork");
  });

  it("lets an explicit mode win over the ambient mode", async () => {
    const captured: SubagentTaskInput[] = [];
    const manager = new SubagentManager({
      worktrees: {} as unknown as WorktreeManager,
      executor: async (input) => {
        captured.push(input);
        return { output: "done" };
      },
    });

    await runWithTurnContext({ mode: "plan" }, () =>
      manager.spawn([{ task: "explicit", mode: "build", writeIsolation: false }]),
    );

    expect(captured[0]?.mode).toBe("build");
  });
});

describe("Task mode persistence", () => {
  it("records the turn mode and forwards it to the spawner", () => {
    const started: TaskSpawnInput[] = [];
    const board = new TaskBoard({
      maxConcurrent: 1,
      spawner: (input) => {
        started.push(input);
        return { workerId: "w", done: never() };
      },
    });

    runWithTurnContext({ mode: "ultrawork" }, () => {
      board.add({ id: "a", title: "A", task: "do a" });
      board.dispatch();
    });

    expect(board.get("a")?.mode).toBe("ultrawork");
    expect(started[0]?.mode).toBe("ultrawork");
  });

  it("restores the mode from the store", () => {
    const database = new MemoryDatabase(":memory:");
    const first = new TaskBoard({
      spawner: () => ({ workerId: "w", done: never() }),
      store: database,
    });
    runWithTurnContext({ mode: "plan" }, () => {
      first.add({ id: "a", title: "A", task: "do a" });
    });

    const restored = new TaskBoard({
      spawner: () => ({ workerId: "w", done: never() }),
      store: database,
    });
    expect(restored.get("a")?.mode).toBe("plan");
  });

  it("adds the mode column to an existing tasks table", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orchivox-task-migration-"));
    const path = join(dir, "memory.db");
    try {
      const raw = new Database(path);
      raw.exec(`CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        task TEXT NOT NULL,
        agent TEXT,
        role_model TEXT,
        provider TEXT,
        model TEXT,
        depends_on TEXT NOT NULL DEFAULT '[]',
        write_isolation INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL,
        worker_id TEXT,
        result TEXT,
        error TEXT,
        diff TEXT,
        files_changed TEXT NOT NULL DEFAULT '[]',
        merged INTEGER,
        merge_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );`);
      raw.close();

      const database = new MemoryDatabase(path);
      const now = Date.now();
      database.saveTask({
        id: "a",
        title: "A",
        task: "do a",
        mode: "plan",
        dependsOn: [],
        writeIsolation: false,
        state: "pending",
        filesChanged: [],
        createdAt: now,
        updatedAt: now,
      });
      expect(database.loadTasks()[0]?.mode).toBe("plan");
      database.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
