import { describe, expect, it } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { AgentHub } from "../src/tui/agent-hub";
import { SubagentManager, type SubagentTaskInput } from "../src/agent/subagent";
import { TaskBoard, type TaskItem, type TaskSpawnInput, type TaskWorkerOutcome } from "../src/agent/task-board";
import { MemoryDatabase } from "../src/memory/sqlite";
import type { WorktreeManager } from "../src/vcs/worktree";
import { getTheme } from "../src/tui/theme";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeBoard(maxConcurrent = 3) {
  const resolvers = new Map<string, (outcome: TaskWorkerOutcome) => void>();
  const started: string[] = [];
  const cancelled: string[] = [];

  const board = new TaskBoard({
    maxConcurrent,
    spawner: (input: TaskSpawnInput) => {
      started.push(input.id);
      let resolve!: (outcome: TaskWorkerOutcome) => void;
      const done = new Promise<TaskWorkerOutcome>((settle) => {
        resolve = settle;
      });
      resolvers.set(input.id, resolve);
      return { workerId: `w-${input.id}`, done };
    },
    canceller: (workerId) => {
      cancelled.push(workerId);
      return true;
    },
  });

  return { board, resolvers, started, cancelled };
}

describe("Task board DAG", () => {
  it("starts tasks only after their dependencies complete", async () => {
    const { board, resolvers, started } = makeBoard();
    board.add([
      { id: "a", title: "A", task: "do a" },
      { id: "b", title: "B", task: "do b", dependsOn: ["a"] },
      { id: "c", title: "C", task: "do c", dependsOn: ["b"] },
    ]);

    expect(board.dispatch()).toBe(1);
    expect(started).toEqual(["a"]);

    resolvers.get("a")?.({ output: "a done" });
    await tick();
    expect(board.get("a")?.state).toBe("completed");
    expect(started).toEqual(["a", "b"]);

    resolvers.get("b")?.({ output: "b done" });
    await tick();
    expect(started).toEqual(["a", "b", "c"]);

    resolvers.get("c")?.({ output: "c done" });
    await tick();
    expect(board.list().every((task) => task.state === "completed")).toBe(true);
  });

  it("blocks dependents when a dependency fails", async () => {
    const { board, resolvers } = makeBoard();
    board.add([
      { id: "root", title: "Root", task: "do root" },
      { id: "child", title: "Child", task: "do child", dependsOn: ["root"] },
    ]);
    board.dispatch();
    resolvers.get("root")?.({ error: "boom" });
    await tick();
    expect(board.get("root")?.state).toBe("failed");
    expect(board.get("child")?.state).toBe("blocked");
  });

  it("respects the concurrency limit", async () => {
    const { board, resolvers, started } = makeBoard(2);
    board.add([
      { id: "a", title: "A", task: "a" },
      { id: "b", title: "B", task: "b" },
      { id: "c", title: "C", task: "c" },
    ]);
    expect(board.dispatch()).toBe(2);
    expect(started).toEqual(["a", "b"]);

    resolvers.get("a")?.({ output: "ok" });
    await tick();
    expect(started).toEqual(["a", "b", "c"]);
  });

  it("cancels a running task through the canceller", () => {
    const { board, cancelled } = makeBoard();
    board.add({ id: "job", title: "Job", task: "run" });
    board.dispatch();
    expect(board.cancel("job")).toBe(true);
    expect(board.get("job")?.state).toBe("cancelled");
    expect(cancelled).toEqual(["w-job"]);
  });

  it("merges a completed task through the merger", async () => {
    let resolveOutcome!: (outcome: TaskWorkerOutcome) => void;
    const merged: string[] = [];
    const board = new TaskBoard({
      spawner: () => ({
        workerId: "w-merge",
        done: new Promise<TaskWorkerOutcome>((resolve) => {
          resolveOutcome = resolve;
        }),
      }),
      merger: async (workerId) => {
        merged.push(workerId);
        return { success: true, diffSummary: "1 file changed", conflicts: [] };
      },
    });

    board.add({ id: "merge-me", title: "Merge", task: "do it" });
    board.dispatch();
    resolveOutcome({ output: "done" });
    await tick();

    const message = await board.merge("merge-me");
    expect(message).toContain("merged merge-me");
    expect(board.get("merge-me")?.merged).toBe(true);
    expect(merged).toEqual(["w-merge"]);
  });

  it("waitForIdle resolves after the started tasks finish", async () => {
    const { board, resolvers } = makeBoard(2);
    board.add([
      { id: "a", title: "A", task: "a" },
      { id: "b", title: "B", task: "b" },
    ]);

    const wait = board.waitForIdle();
    resolvers.get("a")?.({ output: "a done" });
    resolvers.get("b")?.({ output: "b done" });
    await wait;

    expect(board.list().every((task) => task.state === "completed")).toBe(true);
  });
});

describe("Subagent model routing", () => {
  it("forwards role and provider route to the executor", async () => {
    const captured: SubagentTaskInput[] = [];
    const manager = new SubagentManager({
      worktrees: {} as unknown as WorktreeManager,
      executor: async (input) => {
        captured.push(input);
        return { output: "done" };
      },
    });

    const results = await manager.spawn([
      {
        task: "route me",
        roleModel: "fast",
        provider: "openai_primary",
        model: "gpt-4.1-mini",
        writeIsolation: false,
      },
    ]);

    expect(results[0].state).toBe("completed");
    expect(captured[0].roleModel).toBe("fast");
    expect(captured[0].provider).toBe("openai_primary");
    expect(captured[0].model).toBe("gpt-4.1-mini");
    expect(manager.getWorker(results[0].id)?.model).toBe("gpt-4.1-mini");
  });
});

describe("Agent hub tasks tab", () => {
  it("renders task state and selection", () => {
    const task: TaskItem = {
      id: "task-1",
      title: "Build the parser",
      task: "Write the parser",
      agent: "sisyphus",
      roleModel: "main",
      dependsOn: [],
      writeIsolation: true,
      state: "running",
      workerId: "worker-1",
      filesChanged: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });

    const instance = render(
      React.createElement(AgentHub, {
        workers: [],
        tasks: [task],
        initialTab: "tasks" as const,
        theme: getTheme("tokyonight"),
        onSteer: () => undefined,
        onKill: () => undefined,
        onExit: () => undefined,
      }),
      { stdout: stream as unknown as NodeJS.WriteStream, patchConsole: false },
    );

    expect(output).toContain("Tasks (1)");
    expect(output).toContain("Build the parser");
    expect(output).toContain("running");
    instance.unmount();
  });
});

function storageTask(overrides: Partial<TaskItem> & Pick<TaskItem, "id" | "title" | "task">): TaskItem {
  return {
    dependsOn: [],
    writeIsolation: false,
    state: "pending",
    filesChanged: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("Task board persistence", () => {
  const never = (): Promise<TaskWorkerOutcome> => new Promise<TaskWorkerOutcome>(() => undefined);

  it("restores created tasks from the store", () => {
    const database = new MemoryDatabase(":memory:");
    const board = new TaskBoard({
      spawner: () => ({ workerId: "w", done: never() }),
      store: database,
    });
    board.add({ id: "a", title: "A", task: "do a" });

    const restored = new TaskBoard({
      spawner: () => ({ workerId: "w", done: never() }),
      store: database,
    });
    expect(restored.get("a")?.state).toBe("pending");
    expect(restored.get("a")?.title).toBe("A");
  });

  it("turns interrupted running tasks into pending tasks", () => {
    const database = new MemoryDatabase(":memory:");
    const first = new TaskBoard({
      spawner: () => ({ workerId: "w-a", done: never() }),
      store: database,
    });
    first.add({ id: "a", title: "A", task: "do a" });
    first.dispatch();
    expect(first.get("a")?.state).toBe("running");

    const restored = new TaskBoard({
      spawner: () => ({ workerId: "w-a", done: never() }),
      store: database,
    });
    const task = restored.get("a");
    expect(task?.state).toBe("pending");
    expect(task?.workerId).toBeUndefined();
    expect(task?.error).toContain("restart");
  });

  it("keeps completed tasks and their results", async () => {
    const database = new MemoryDatabase(":memory:");
    const first = new TaskBoard({
      spawner: () => ({ workerId: "w-a", done: Promise.resolve({ output: "done" }) }),
      store: database,
    });
    first.add({ id: "a", title: "A", task: "do a" });
    first.dispatch();
    await tick();
    expect(first.get("a")?.state).toBe("completed");

    const restored = new TaskBoard({
      spawner: () => ({ workerId: "w-a", done: Promise.resolve({ output: "done" }) }),
      store: database,
    });
    expect(restored.get("a")?.state).toBe("completed");
    expect(restored.get("a")?.result).toBe("done");
  });

  it("blocks restored tasks whose dependency is missing", () => {
    const database = new MemoryDatabase(":memory:");
    database.saveTask(storageTask({ id: "b", title: "B", task: "do b", dependsOn: ["missing"] }));
    const board = new TaskBoard({
      spawner: () => ({ workerId: "w", done: never() }),
      store: database,
    });
    expect(board.get("b")?.state).toBe("blocked");
    expect(board.get("b")?.error).toContain("missing");
  });

  it("removes tasks from the store", () => {
    const database = new MemoryDatabase(":memory:");
    const board = new TaskBoard({
      spawner: () => ({ workerId: "w", done: never() }),
      store: database,
    });
    board.add({ id: "a", title: "A", task: "do a" });
    expect(board.remove("a")).toBe(true);

    const restored = new TaskBoard({
      spawner: () => ({ workerId: "w", done: never() }),
      store: database,
    });
    expect(restored.get("a")).toBeUndefined();
  });
});
