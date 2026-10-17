import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { z } from "zod";

import {
  AgentTaskRequestSchema,
  AgentTaskSchema,
  type IAgentRunner,
} from "./server";

const ErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.string().optional(),
  }),
});

export function registerSpecAndTaskRoutes(app: OpenAPIHono, runner: IAgentRunner): void {
  const createTaskRoute = createRoute({
    method: "post",
    path: "/v1/agent/tasks",
    summary: "Assign an asynchronous agent task",
    description:
      "Queues a background task. When the task finishes the runner posts the final task record to webhook_url, if one was given.",
    tags: ["agent-tasks"],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: AgentTaskRequestSchema } },
      },
    },
    responses: {
      202: {
        description: "The queued task record",
        content: { "application/json": { schema: AgentTaskSchema } },
      },
      400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
      401: { description: "Missing or invalid api key", content: { "application/json": { schema: ErrorSchema } } },
      500: { description: "Runner failure", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  const getTaskRoute = createRoute({
    method: "get",
    path: "/v1/agent/tasks/{id}",
    summary: "Inspect an asynchronous agent task",
    description: "Returns the current task record, including the result once the task completed.",
    tags: ["agent-tasks"],
    request: {
      params: z.object({ id: z.string().min(1) }),
    },
    responses: {
      200: {
        description: "The task record",
        content: { "application/json": { schema: AgentTaskSchema } },
      },
      401: { description: "Missing or invalid api key", content: { "application/json": { schema: ErrorSchema } } },
      404: { description: "Unknown task id", content: { "application/json": { schema: ErrorSchema } } },
    },
  });

  app.openapi(createTaskRoute, async (c) => {
    const body = c.req.valid("json");
    const task = await runner.startTask(body);
    return c.json(task, 202);
  });

  app.openapi(getTaskRoute, async (c) => {
    const task = await runner.getTask(c.req.param("id"));
    if (!task) {
      return c.json({ error: { message: "task not found", type: "invalid_request_error" } }, 404);
    }
    return c.json(task, 200);
  });

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Orchivox Agent Gateway", version: "0.1.0" },
  });

  app.get("/docs", Scalar({ url: "/openapi.json", theme: "kepler" }));
}
