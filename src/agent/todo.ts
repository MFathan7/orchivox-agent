import { z } from "zod";

import type { AgentTool, ToolRegistry } from "../tools/registry";
import {
  TodoItemSchema,
  TodoPrioritySchema,
  TodoStatusSchema,
  type TodoItem,
  type TodoPriority,
  type TodoStatus,
} from "../types/schema";

export interface TodoStatusReport {
  hasPending: boolean;
  continuationPrompt: string;
}

export class TodoEngine {
  private items: TodoItem[] = [];

  registerTools(registry: ToolRegistry): void {
    registry.register(this.writeTool());
    registry.register(this.readTool());
  }

  list(): TodoItem[] {
    return [...this.items];
  }

  progress(): { done: number; total: number } {
    const done = this.items.filter((item) => item.status === "completed").length;
    return { done, total: this.items.length };
  }

  checkPendingTodos(): TodoStatusReport {
    const open = this.items.filter((item) => item.status === "pending" || item.status === "in_progress");
    if (open.length === 0) return { hasPending: false, continuationPrompt: "" };
    const lines = open.map((item) => `- [${item.status}] (${item.priority}) ${item.task}`);
    return {
      hasPending: true,
      continuationPrompt: [
        `There are still ${open.length} open todo item(s):`,
        ...lines,
        "Continue working and call tools until every todo item is completed.",
      ].join("\n"),
    };
  }

  private writeTool(): AgentTool {
    return {
      name: "todo_write",
      description:
        "Replace the session todo list with the given items. Use one item per concrete task and update status as work progresses.",
      parameters: z.object({
        todos: z.array(
          z.object({
            id: z.string().min(1).optional(),
            task: z.string().min(1),
            status: TodoStatusSchema,
            priority: TodoPrioritySchema,
          }),
        ),
      }),
      readOnly: false,
      execute: (args) => {
        const request = args as {
          todos: Array<{ id?: string; task: string; status: TodoStatus; priority: TodoPriority }>;
        };
        this.items = request.todos.map((entry, index) =>
          TodoItemSchema.parse({
            id: entry.id ?? `todo-${Date.now().toString(36)}-${index}`,
            task: entry.task,
            status: entry.status,
            priority: entry.priority,
          }),
        );
        const { done, total } = this.progress();
        return `todo list updated: ${done}/${total} completed`;
      },
    };
  }

  private readTool(): AgentTool {
    return {
      name: "todo_read",
      description: "Read the current session todo list with status and priority.",
      parameters: z.object({}),
      readOnly: true,
      execute: () => {
        if (this.items.length === 0) return "todo list is empty";
        return this.items
          .map((item) => `- [${item.status}] (${item.priority}) ${item.task} (${item.id})`)
          .join("\n");
      },
    };
  }
}
