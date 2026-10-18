import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

import type { McpServerConfig } from "../config/loader";
import type { AgentTool, ToolRegistry } from "../tools/registry";
import type { JsonSchemaObject } from "../types/schema";

export interface McpConnectionReport {
  connected: Array<{ server: string; tools: string[] }>;
  failed: Array<{ server: string; error: string }>;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class McpClientManager {
  private readonly registry: ToolRegistry;
  private readonly clients = new Map<string, Client>();

  constructor(options: { registry: ToolRegistry }) {
    this.registry = options.registry;
  }

  listServers(): string[] {
    return [...this.clients.keys()];
  }

  async connectAll(servers: Record<string, McpServerConfig>): Promise<McpConnectionReport> {
    const report: McpConnectionReport = { connected: [], failed: [] };
    for (const [name, config] of Object.entries(servers)) {
      if (config.enabled === false) continue;
      try {
        const tools = await this.connect(name, config);
        report.connected.push({ server: name, tools });
      } catch (error) {
        report.failed.push({ server: name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return report;
  }

  async connect(name: string, config: McpServerConfig): Promise<string[]> {
    if (this.clients.has(name)) throw new Error(`mcp server "${name}" is already connected`);
    const client = new Client({ name: "orchivox-agent", version: "0.1.0" });
    await client.connect(this.buildTransport(name, config));
    this.clients.set(name, client);

    const listed = await client.listTools();
    const registered: string[] = [];
    for (const tool of listed.tools ?? []) {
      const toolName = `mcp__${name}__${tool.name}`;
      this.registry.register(this.wrapTool(name, client, toolName, tool as unknown as McpToolInfo));
      registered.push(toolName);
    }
    return registered;
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close().catch(() => undefined);
    }
    this.clients.clear();
  }

  private buildTransport(name: string, config: McpServerConfig) {
    if (config.transport === "stdio") {
      if (!config.command) throw new Error(`mcp server "${name}" needs a command for stdio transport`);
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...collectEnv(), ...config.env },
        stderr: "pipe",
      });
    }
    if (!config.url) throw new Error(`mcp server "${name}" needs a url for ${config.transport} transport`);
    const url = new URL(config.url);
    const requestInit =
      config.headers && Object.keys(config.headers).length > 0 ? { headers: config.headers } : undefined;
    if (config.transport === "sse") {
      return new SSEClientTransport(url, requestInit ? { requestInit } : undefined);
    }
    return new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
  }

  private wrapTool(serverName: string, client: Client, toolName: string, tool: McpToolInfo): AgentTool {
    return {
      name: toolName,
      description: `(MCP server ${serverName}) ${tool.description ?? tool.name}`,
      parameters: z.record(z.string(), z.unknown()),
      parametersJsonSchema: tool.inputSchema as JsonSchemaObject,
      readOnly: false,
      execute: async (args) => {
        const result = await client.callTool({
          name: tool.name,
          arguments: args as Record<string, unknown>,
        });
        const parts = (result.content ?? []) as Array<{ type?: string; text?: string }>;
        const text = parts
          .map((part) => (part.type === "text" ? (part.text ?? "") : JSON.stringify(part)))
          .join("\n");
        if (result.isError) throw new Error(text || `mcp tool "${tool.name}" failed`);
        return text;
      },
    };
  }
}

function collectEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(globalThis.process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
