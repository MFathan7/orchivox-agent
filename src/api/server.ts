import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import {
  DoneEventSchema,
  MessageSchema,
  SubagentResultSchema,
  SubagentStateSchema,
  ToolDefinitionSchema,
  UsageSchema,
  type StreamEvent,
} from "../types/schema";
import { registerAnthropicRoutes } from "./anthropic-routes";
import { registerOpenAIRoutes } from "./openai-routes";
import { registerSpecAndTaskRoutes } from "./openapi-spec";

export const AGENT_PROFILES = ["orchivox-main", "orchivox-plan", "orchivox-ultrawork"] as const;

export const AgentProfileSchema = z.enum(AGENT_PROFILES);
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const ToolChoiceSchema = z.object({
  mode: z.enum(["auto", "none", "required"]),
  name: z.string().min(1).optional(),
});
export type ToolChoice = z.infer<typeof ToolChoiceSchema>;

export const AgentRunRequestSchema = z.object({
  profile: AgentProfileSchema,
  task: z.enum(["study", "review"]).optional(),
  system: z.string().optional(),
  messages: z.array(MessageSchema).min(1),
  tools: z.array(ToolDefinitionSchema).default([]),
  tool_choice: ToolChoiceSchema.default({ mode: "auto" }),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop_sequences: z.array(z.string().min(1)).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  reasoning_effort: z.string().min(1).optional(),
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

export const AgentRunResultSchema = z.object({
  message: MessageSchema,
  usage: UsageSchema.optional(),
  finish_reason: DoneEventSchema.shape.finish_reason,
});
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;

export const AgentTaskRequestSchema = z.object({
  task: z.string().min(1),
  profile: AgentProfileSchema.default("orchivox-main"),
  webhook_url: z.url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AgentTaskRequest = z.infer<typeof AgentTaskRequestSchema>;

export const AgentTaskSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  profile: AgentProfileSchema,
  webhook_url: z.url().optional(),
  status: SubagentStateSchema,
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  result: SubagentResultSchema.optional(),
});
export type AgentTask = z.infer<typeof AgentTaskSchema>;

export interface IAgentRunner {
  /** Runs one complete turn and returns the final assistant message. */
  runOnce(request: AgentRunRequest): Promise<AgentRunResult>;
  /** Streams one turn; rewind events are resolved by the runner. Tool activity arrives as tool_start/tool_end/file_change. */
  runStream(request: AgentRunRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown>;
  /** Starts a background task; the runner posts the finished task record to request.webhook_url. */
  startTask(request: AgentTaskRequest): Promise<AgentTask>;
  /** Returns the current task record, or undefined when the id is unknown. */
  getTask(id: string): Promise<AgentTask | undefined>;
}

export interface AgentGatewayServerOptions {
  runner: IAgentRunner;
  apiKey?: string;
  corsOrigins?: string[];
}

export class AgentGatewayServer {
  readonly app: OpenAPIHono;

  constructor(options: AgentGatewayServerOptions) {
    const app = new OpenAPIHono({
      defaultHook: (result, c) => {
        if (result.success) return;
        return c.json(
          {
            error: {
              message: "request validation failed",
              type: "invalid_request_error",
              issues: result.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            },
          },
          400,
        );
      },
    });

    const allowedOrigins = new Set(options.corsOrigins ?? ["*"]);
    app.use(
      "*",
      cors({
        origin: (origin) => (allowedOrigins.has("*") || allowedOrigins.has(origin) ? origin : null),
      }),
    );
    app.use("*", logger());
    if (options.apiKey) app.use("/v1/*", bearerOrApiKeyAuth(options.apiKey));

    app.onError((error, c) => {
      return c.json(
        {
          error: {
            message: error instanceof Error ? error.message : "internal server error",
            type: "server_error",
          },
        },
        500,
      );
    });

    registerSpecAndTaskRoutes(app, options.runner);
    registerOpenAIRoutes(app, options.runner);
    registerAnthropicRoutes(app, options.runner);

    this.app = app;
  }

  serve(port: number, hostname: string = "127.0.0.1") {
    return Bun.serve({ port, hostname, fetch: (request) => this.app.fetch(request) });
  }
}

function bearerOrApiKeyAuth(apiKey: string): MiddlewareHandler {
  return async (c, next) => {
    const authorization = c.req.header("authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
    const presented = bearer ?? c.req.header("x-api-key");
    if (presented !== apiKey) {
      return c.json({ error: { message: "missing or invalid api key", type: "authentication_error" } }, 401);
    }
    await next();
  };
}
