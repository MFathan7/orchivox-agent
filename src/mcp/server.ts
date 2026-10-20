import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { toolParametersToJsonSchema, type AgentMode, type JsonSchemaObject } from "../types/schema";
import type { ToolRegistry } from "../tools/registry";

export interface McpToolServerOptions {
  registry: ToolRegistry;
  mode?: AgentMode;
  serverName?: string;
  version?: string;
}

export class McpToolServer {
  private readonly server: Server;
  private readonly registry: ToolRegistry;
  private readonly mode: AgentMode;
  private callCounter = 0;

  constructor(options: McpToolServerOptions) {
    this.registry = options.registry;
    this.mode = options.mode ?? "build";
    this.server = new Server(
      { name: options.serverName ?? "orchivox-agent", version: options.version ?? "0.2.0" },
      { capabilities: { tools: {} } },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.registry.list().map((tool) => {
        const schema = (tool.parametersJsonSchema ?? toolParametersToJsonSchema(tool.parameters)) as JsonSchemaObject;
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: { ...schema, type: "object" } as { type: "object" } & Record<string, unknown>,
        };
      }),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.callCounter += 1;
      const result = await this.registry.run(
        {
          id: `mcp-${this.callCounter}`,
          name: request.params.name,
          arguments: (request.params.arguments ?? {}) as Record<string, unknown>,
        },
        this.mode,
      );
      const text =
        typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      return { content: [{ type: "text" as const, text }], isError: result.is_error };
    });
  }

  async startStdio(): Promise<void> {
    await this.server.connect(new StdioServerTransport());
  }

  async connect(transport: Parameters<Server["connect"]>[0]): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    await this.server.close();
  }
}
