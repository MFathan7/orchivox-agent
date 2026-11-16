import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

import { McpLifecycleConfigSchema, type McpLifecycleConfig, type McpServerConfig } from "../config/loader";
import type { AgentTool, ToolRegistry } from "../tools/registry";
import type { JsonSchemaObject } from "../types/schema";
import { McpSchemaValidator } from "./schema-validator";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { McpError, ErrorCode, ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema, PromptListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpToolResultEnvelopeSchema, mcpToolOutput } from "./tool-result";
import { catalogTools, queryMcpCatalog, mcpRequestFailure, type McpCapabilities, type McpCatalogQuery } from "./catalog";
import { currentTurnContext } from "../agent/turn-context";
import type { ToolOutput, ToolProgress } from "../types/tool-output";
import type { SkillRegistry } from "../agent/skills";
import { DEFAULT_MAX_BYTES } from "../tools/output-budget";
import { McpAuthManager, McpLoginRequired } from "./auth";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { McpCatalogCache, McpToolInfoSchema, catalogHash, mcpCacheIdentity, type McpToolInfo } from "./cache";
import { McpConnectionPool, McpConnectionReplaced, McpConnectionTimeout, McpProgressRelay, McpManagedTransport } from "./lifecycle";
export { mcpToolOutput } from "./tool-result";

export interface McpConnectionReport {
  connected: Array<{ server: string; tools: string[] }>;
  failed: Array<{ server: string; error: string }>;
}

interface Connection {
  name: string; config: McpServerConfig; identity: string; group: string; client: Client; controller: AbortController;
  phase: "connecting" | "connected" | "reconnecting" | "failed" | "disconnected";
  desired: boolean; attempt: number; toolsEpoch: number; resourcesEpoch: number; promptsEpoch: number; toolsStale: boolean;
  schemas: Map<string, string>; timer?: ReturnType<typeof setTimeout>; refreshTimer?: ReturnType<typeof setTimeout>;
  connecting?: Promise<string[]>; refreshing?: Promise<void>; closing?: Promise<void>;
  transportFailed?: boolean;
}

export class McpClientManager {
  private readonly registry: ToolRegistry;
  private readonly clients = new Map<string, Client>();
  private readonly tools = new Map<string, string[]>();
  private readonly failures = new Map<string, string>();
  private readonly pending = new Set<Client>();
  private readonly connections = new Map<string, Connection>();
  private readonly listeners = new Set<() => void>();
  private readonly pool: McpConnectionPool;
  private readonly cache: McpCatalogCache;
  private readonly scope: string;
  private readonly lifecycle: McpLifecycleConfig;
  private changeTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly validator = new McpSchemaValidator();
  private catalogRegistered = false;
  private readonly skills?: SkillRegistry;
  private readonly auth?: McpAuthManager;
  private readonly configs = new Map<string, McpServerConfig>();

  constructor(options: { registry: ToolRegistry; skills?: SkillRegistry; auth?: McpAuthManager; lifecycle?: Partial<McpLifecycleConfig>; cacheDirectory?: string; scope?: string }) {
    this.registry = options.registry;
    this.skills = options.skills;
    this.auth = options.auth;
    this.lifecycle = McpLifecycleConfigSchema.parse(options.lifecycle ?? {});
    this.pool = new McpConnectionPool(this.lifecycle.connect_concurrency);
    this.cache = new McpCatalogCache(options.cacheDirectory);
    this.scope = options.scope ?? process.cwd();
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() {
    if (this.closed || this.changeTimer) return;
    this.changeTimer = setTimeout(() => { this.changeTimer = undefined; if (!this.closed) for (const listener of this.listeners) listener(); }, 50);
  }
  configureLifecycle(value: Partial<McpLifecycleConfig>) { Object.assign(this.lifecycle, McpLifecycleConfigSchema.parse(value)); this.pool.setLimit(this.lifecycle.connect_concurrency); }
  status(server: string) {
    const connection = this.connections.get(server), cached = connection ? this.cache.get(connection.identity) : undefined;
    return { phase: connection?.phase ?? "disconnected", attempt: connection?.attempt ?? 0, stale: !this.clients.has(server) || connection?.toolsStale === true,
      cachedTools: cached?.tools.map((tool) => `mcp__${server}__${tool.name}`) ?? [], cachedCapabilities: cached?.capabilities,
      serverVersion: cached?.server.version, fingerprint: cached?.fingerprint,
      revision: connection ? `${connection.group}:${connection.toolsEpoch}:${connection.resourcesEpoch}:${connection.promptsEpoch}` : "none" };
  }
  private current(connection: Connection) { return !this.closed && this.connections.get(connection.name) === connection; }
  private live(connection: Connection) { return this.current(connection) && !connection.controller.signal.aborted && this.clients.get(connection.name) === connection.client; }
  private assertCurrent(connection: Connection) { if (!this.current(connection) || connection.controller.signal.aborted) throw new McpConnectionReplaced(); }
  authStatus(server: string, config: McpServerConfig) { return this.auth?.status(server, config); }
  onAuthChange(listener: () => void) { return this.auth?.subscribe(listener) ?? (() => {}); }
  private clean<T>(value: T): T { return this.auth?.redactor.sanitize(value) ?? value; }
  async authenticate(server: string, config: McpServerConfig, action: "login" | "logout" | "refresh" | "cancel" | "open", storage?: "native" | "session", signal?: AbortSignal): Promise<string> {
    if (this.closed) throw new Error("MCP manager is closed.");
    if (!this.auth) throw new Error("OAuth is unavailable in this MCP host.");
    if (action === "cancel") return this.auth.cancelLogin(server, config);
    if (action === "open") return this.auth.openLogin(server, config);
    if (this.auth.status(server, config).state === "manual") {
      if (action === "logout") return "This server uses manual credentials. OAuth logout does not change its headers/env; configure or disable the server instead.";
      throw new Error("This server uses stdio or a manual Authorization header. Manage those credentials outside OAuth login.");
    }
    if (action === "logout") { await this.disconnect(server); return this.auth.logout(server, config); }
    if (!config.enabled) throw new Error("Enable the server before signing in or refreshing credentials.");
    if (action === "login" && !storage) throw new Error("Choose native or session credential storage before login.");
    await this.disconnect(server);
    const result = action === "login" ? await this.auth.login(server, config, storage!, signal) : await this.auth.refresh(server, config, signal);
    try { await this.connect(server, config); return `${result} Server connected.`; }
    catch { return `${result} Connection failed; reconnect from /mcp when the server is available.`; }
  }

  listServers(): string[] {
    return [...this.clients.keys()];
  }

  toolNames(server: string): string[] { return [...(this.tools.get(server) ?? [])]; }
  failure(server: string): string | undefined { return this.failures.get(server); }
  capabilities(server: string): McpCapabilities {
    const value = this.clients.get(server)?.getServerCapabilities();
    return { tools: !!value?.tools, resources: !!value?.resources, prompts: !!value?.prompts };
  }

  async query(query: McpCatalogQuery, signal?: AbortSignal, progress?: (value: ToolProgress) => void): Promise<ToolOutput> {
    if (signal?.aborted) return mcpRequestFailure(signal.reason, signal);
    if (currentTurnContext()?.mode === "plan") return { status: "unavailable", code: "mcp_plan_restricted", text: "MCP resources and prompts are unavailable in PLAN mode." };
    const connection = this.connections.get(query.server);
    const pageKey = query.action === "list" || query.action === "templates" ? `${query.kind}:${JSON.stringify([query.action, query.cursor ?? null])}` : undefined;
    const cached = connection ? this.cache.get(connection.identity) : undefined, page = pageKey ? cached?.pages[pageKey] : undefined;
    if (page && (!connection || !this.live(connection) || Date.now() - page.capturedAt < this.lifecycle.cache_ttl_ms)) {
      const stale = !connection || !this.live(connection) || connection.toolsStale;
      return this.clean({ ...page.output, ...(stale ? { status: "partial" as const, reason: "Cached MCP metadata is stale; it does not establish a live connection or grant tool access." } : {}),
        text: `${page.output.text ?? ""}\nMetadata cache captured at ${new Date(page.capturedAt).toISOString()}${stale ? "; server metadata is stale" : ""}.`,
        metadata: { mcp_catalog: { cached: true, stale, capturedAt: page.capturedAt, revision: this.status(query.server).revision } } });
    }
    const client = this.clients.get(query.server);
    if (!client) return { status: "unavailable", code: "mcp_disconnected", text: `MCP server ${JSON.stringify(query.server)} is not connected.` };
    if (!this.capabilities(query.server)[query.kind]) return { status: "unavailable", code: "mcp_capability_unavailable", text: `MCP server ${JSON.stringify(query.server)} does not provide ${query.kind}.` };
    try {
      const epoch = query.kind === "resources" ? connection!.resourcesEpoch : connection!.promptsEpoch;
      const output = this.clean(await this.request(connection!, signal, progress, (options) => queryMcpCatalog(client, query, options.signal, options)));
      if (pageKey) {
        const stale = epoch !== (query.kind === "resources" ? connection!.resourcesEpoch : connection!.promptsEpoch), capturedAt = Date.now();
        if (stale) { output.status = "partial"; output.reason = "MCP metadata changed during this request; this page is a snapshot and may be stale."; }
        else {
          const cache = this.cache.get(connection!.identity);
          if (cache) this.cache.set({ ...cache, pages: Object.fromEntries([...Object.entries(cache.pages).filter(([key]) => key !== pageKey).slice(-63), [pageKey, { output, capturedAt }]]) });
        }
        output.metadata = { mcp_catalog: { cached: false, stale, capturedAt, revision: this.status(query.server).revision } };
      }
      return output;
    }
    catch (error) { this.authFailure(query.server, error); return this.clean({ ...mcpRequestFailure(error, signal), sources: [{ uri: `mcp://${encodeURIComponent(query.server)}/${query.kind}`, title: `MCP server ${query.server}` }] }); }
  }

  async selectSkill(server: string, uri: string, signal?: AbortSignal): Promise<string> {
    if (!this.skills) throw new Error("MCP resource skills are unavailable in this host.");
    const absolute = new URL(uri).href;
    const document = await this.skills.selectResource({ server, uri: absolute, read: async (signal) => {
      if (currentTurnContext()?.mode === "plan") throw new Error("MCP resource skills are unavailable in PLAN mode.");
      const client = this.clients.get(server);
      if (!client) throw new Error(`MCP server ${JSON.stringify(server)} is not connected.`);
      if (!this.capabilities(server).resources) throw new Error(`MCP server ${JSON.stringify(server)} does not provide resources.`);
      signal?.throwIfAborted();
      const turn = currentTurnContext();
      const progress = turn?.toolCallId ? (value: ToolProgress) => turn.onToolProgress?.({ id: turn.toolCallId!, name: "skill", progress: value }) : undefined;
      const result = await this.request(this.connections.get(server)!, signal, progress, (options) => client.readResource({ uri: absolute }, options));
      signal?.throwIfAborted();
      if (this.clients.get(server) !== client) throw new Error("MCP server disconnected while loading the resource skill.");
      if (result.contents.length !== 1 || !("text" in result.contents[0]!) || result.contents[0]!.uri !== absolute) throw new Error("A resource skill must return one complete text document at the requested URI.");
      const raw = result.contents[0]!.text as string;
      if (Buffer.byteLength(raw) > DEFAULT_MAX_BYTES) throw new Error(`Resource skill exceeds the ${DEFAULT_MAX_BYTES}-byte skill loading limit. Read it as a resource instead.`);
      return this.clean(raw);
    } }, signal);
    return `Selected external skill ${document.id} from MCP server ${JSON.stringify(server)} (${absolute}). Load it with /skill:${document.id}. Selection does not execute its workflow or change permissions. Selection lasts until disconnect or process exit.`;
  }

  async disconnect(server: string): Promise<void> {
    const connection = this.connections.get(server);
    if (connection) {
      connection.desired = false; if (connection.timer) clearTimeout(connection.timer); if (connection.refreshTimer) clearTimeout(connection.refreshTimer);
      connection.controller.abort(new McpConnectionReplaced()); connection.phase = "disconnected"; this.unpublish(connection);
      await this.closeClient(connection); await connection.connecting?.catch(() => {});
    }
    this.failures.delete(server);
    this.skills?.removeResources(server);
    this.changed();
  }

  async connectAll(servers: Record<string, McpServerConfig>): Promise<McpConnectionReport> {
    const report: McpConnectionReport = { connected: [], failed: [] };
    await Promise.all(Object.entries(servers).map(async ([name, config]) => {
      if (config.enabled === false) return;
      try {
        const tools = await this.connect(name, config);
        report.connected.push({ server: name, tools });
      } catch (error) {
        report.failed.push({ server: name, error: error instanceof Error ? error.message : String(error) });
      }
    }));
    const order = new Map(Object.keys(servers).map((name, index) => [name, index]));
    report.connected.sort((a, b) => order.get(a.server)! - order.get(b.server)!); report.failed.sort((a, b) => order.get(a.server)! - order.get(b.server)!);
    return report;
  }

  async connect(name: string, config: McpServerConfig, signal?: AbortSignal): Promise<string[]> {
    if (this.closed) throw new Error("MCP manager is closed");
    if (this.clients.has(name)) throw new Error(`mcp server "${name}" is already connected`);
    if (this.connections.get(name)?.connecting) throw new Error(`mcp server "${name}" is already connecting`);
    return this.startConnection(name, config, 0, signal);
  }

  private startConnection(name: string, config: McpServerConfig, attempt: number, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted();
    const previous = this.connections.get(name); if (previous?.timer) clearTimeout(previous.timer);
    const client = new Client({ name: "orchivox-agent", version: "0.2.0" }, { jsonSchemaValidator: this.validator });
    const connection: Connection = { name, config, identity: mcpCacheIdentity(this.scope, name, config), group: crypto.randomUUID(), client, controller: new AbortController(),
      phase: attempt ? "reconnecting" : "connecting", desired: true, attempt, toolsEpoch: 0, resourcesEpoch: 0, promptsEpoch: 0, toolsStale: true, schemas: new Map() };
    this.connections.set(name, connection); this.pending.add(client); this.installNotifications(connection); this.changed();
    const aborted = () => connection.controller.abort(signal?.reason); signal?.addEventListener("abort", aborted, { once: true });
    const connecting = this.pool.run(connection.controller.signal, async () => {
      const timeout = setTimeout(() => connection.controller.abort(new McpConnectionTimeout()), this.lifecycle.connect_timeout_ms);
      let rejectAbort!: (error: unknown) => void;
      const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const stop = () => { void this.closeClient(connection); rejectAbort(connection.controller.signal.reason ?? new McpConnectionReplaced()); };
      connection.controller.signal.addEventListener("abort", stop, { once: true });
      try {
        return await Promise.race([cancelled, (async () => {
          await this.cache.load(connection.identity); this.assertCurrent(connection); this.changed();
          this.auth?.rememberConfig(config); const provider = await this.auth?.provider(name, config); this.assertCurrent(connection);
          const transport = new McpManagedTransport(this.buildTransport(name, config, provider), (error) => {
            if (!this.current(connection) || !connection.desired || connection.controller.signal.aborted) return;
            const code = "code" in error ? error.code : undefined;
            if (code === 400 || code === 422) return;
            this.authFailure(name, error, config); connection.transportFailed = true;
            if (this.live(connection)) this.connectionLost(connection); else connection.controller.abort(error);
            void this.closeClient(connection);
          });
          await client.connect(transport, { signal: connection.controller.signal, timeout: this.lifecycle.connect_timeout_ms }); this.assertCurrent(connection);
          const tools = await this.discoverTools(connection); this.assertCurrent(connection);
          this.publish(connection, tools); this.clients.set(name, client); this.configs.set(name, config); connection.phase = "connected";
          this.ensureCatalogTools(); this.saveTools(connection, tools); this.failures.delete(name); this.changed(); return this.toolNames(name);
        })()]);
      } finally { clearTimeout(timeout); connection.controller.signal.removeEventListener("abort", stop); }
    }).catch(async (error) => {
      this.authFailure(name, error, config); this.unpublish(connection); await this.closeClient(connection);
      if (this.current(connection) && connection.desired) {
        connection.phase = "failed"; this.failures.set(name, this.clean(error instanceof Error ? error.message : String(error)));
        const transportFailure = connection.transportFailed || error instanceof McpConnectionTimeout || error instanceof McpError && error.code === ErrorCode.ConnectionClosed;
        if (!signal?.aborted && (attempt > 0 || transportFailure)) this.scheduleReconnect(connection);
        this.changed();
      }
      throw new Error(this.clean(error instanceof Error ? error.message : String(error)));
    }).finally(() => { this.pending.delete(client); connection.connecting = undefined; signal?.removeEventListener("abort", aborted); });
    connection.connecting = connecting; return connecting;
  }

  private closeClient(connection: Connection) { return connection.closing ??= connection.client.close().catch(() => {}); }
  private unpublish(connection: Connection) {
    this.registry.unregisterGroup(connection.group);
    if (this.clients.get(connection.name) === connection.client) { this.clients.delete(connection.name); this.configs.delete(connection.name); this.tools.delete(connection.name); }
  }
  private ensureCatalogTools() {
    if (this.catalogRegistered || !this.listServers().some((name) => this.capabilities(name).resources || this.capabilities(name).prompts)) return;
    const registered: string[] = [];
    try {
      for (const tool of catalogTools({ servers: (kind) => this.listServers().filter((server) => this.capabilities(server)[kind]), query: (query, signal, progress) => this.query(query, signal, progress) })) { this.registry.register(tool); registered.push(tool.name); }
      this.catalogRegistered = true;
    } catch (error) { for (const name of registered) this.registry.unregister(name); throw error; }
  }
  private async discoverTools(connection: Connection, signal = connection.controller.signal): Promise<McpToolInfo[]> {
    if (!connection.client.getServerCapabilities()?.tools) return [];
    for (let round = 0; round < 3; round++) {
      const epoch = connection.toolsEpoch, tools: McpToolInfo[] = [], cursors = new Set<string>(); let cursor: string | undefined;
      for (let page = 0; page < this.lifecycle.max_catalog_pages; page++) {
        signal.throwIfAborted(); const result = await connection.client.listTools({ cursor }, { signal, timeout: this.lifecycle.request_timeout_ms }); this.assertCurrent(connection); signal.throwIfAborted();
        tools.push(...result.tools.map((tool) => this.clean(McpToolInfoSchema.parse(tool))));
        cursor = result.nextCursor; if (cursor === undefined) break;
        if (cursors.has(cursor)) throw new Error("MCP tools/list repeated a pagination cursor."); cursors.add(cursor);
        if (page + 1 === this.lifecycle.max_catalog_pages) throw new Error("MCP tool catalog exceeded max_catalog_pages; no partial catalog was registered.");
      }
      if (epoch === connection.toolsEpoch) return tools;
    }
    throw new Error("MCP catalog changed repeatedly during discovery; reconnect when it settles.");
  }
  private publish(connection: Connection, tools: McpToolInfo[]) {
    this.assertCurrent(connection);
    const wrapped = tools.map((tool) => this.wrapTool(connection, tool));
    this.registry.replaceGroup(connection.group, wrapped); connection.schemas = new Map(tools.map((tool) => [tool.name, catalogHash(tool)]));
    connection.toolsStale = false; this.tools.set(connection.name, wrapped.map((tool) => tool.name));
  }
  private saveTools(connection: Connection, tools: McpToolInfo[], preservePages = false) {
    const server = connection.client.getServerVersion()!, fingerprint = catalogHash([server.name, server.version, tools]);
    const previous = this.cache.get(connection.identity);
    this.cache.set({ format: 1, identity: connection.identity, server: { name: server.name, version: server.version }, fingerprint,
      capabilities: this.capabilities(connection.name), tools, capturedAt: Date.now(), pages: preservePages && previous?.fingerprint === fingerprint ? previous.pages : {} });
  }
  private scheduleReconnect(connection: Connection) {
    if (!this.current(connection) || !connection.desired || connection.attempt >= this.lifecycle.reconnect_attempts || this.auth?.status(connection.name, connection.config).state === "login_required") return;
    connection.phase = "reconnecting";
    connection.timer = setTimeout(() => {
      if (this.current(connection) && connection.desired) void this.startConnection(connection.name, connection.config, connection.attempt + 1).catch(() => {});
    }, Math.min(5000, this.lifecycle.reconnect_delay_ms * 2 ** connection.attempt));
  }
  private installNotifications(connection: Connection) {
    connection.client.onclose = () => this.connectionLost(connection);
    const invalidate = (kind: "tools" | "resources" | "prompts") => {
      if (!this.current(connection) || !connection.desired) return;
      if (kind === "tools") { connection.toolsEpoch++; connection.toolsStale = true; if (this.live(connection)) this.refreshTools(connection); }
      else {
        if (kind === "resources") connection.resourcesEpoch++; else connection.promptsEpoch++;
        const cache = this.cache.get(connection.identity);
        if (cache) this.cache.set({ ...cache, pages: Object.fromEntries(Object.entries(cache.pages).filter(([key]) => !key.startsWith(`${kind}:`))) });
      }
      this.changed();
    };
    connection.client.setNotificationHandler(ToolListChangedNotificationSchema, () => { if (connection.client.getServerCapabilities()?.tools?.listChanged) invalidate("tools"); });
    connection.client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { if (connection.client.getServerCapabilities()?.resources?.listChanged) invalidate("resources"); });
    connection.client.setNotificationHandler(PromptListChangedNotificationSchema, () => { if (connection.client.getServerCapabilities()?.prompts?.listChanged) invalidate("prompts"); });
  }
  private connectionLost(connection: Connection) {
    if (!this.live(connection)) return;
    this.unpublish(connection); connection.controller.abort(new McpConnectionReplaced()); connection.phase = "failed"; connection.toolsStale = true;
    this.skills?.removeResources(connection.name); this.failures.set(connection.name, "MCP connection closed. In-flight tool calls were not replayed."); this.scheduleReconnect(connection); this.changed();
  }
  private refreshTools(connection: Connection) {
    if (connection.refreshTimer) clearTimeout(connection.refreshTimer);
    connection.refreshTimer = setTimeout(() => {
      if (!this.live(connection) || connection.refreshing) return;
      connection.refreshing = (async () => {
        try { const tools = await this.discoverTools(connection, AbortSignal.any([connection.controller.signal, AbortSignal.timeout(this.lifecycle.connect_timeout_ms)])); this.assertCurrent(connection); this.publish(connection, tools); this.saveTools(connection, tools, true); this.failures.delete(connection.name); }
        catch (error) { if (this.live(connection)) { this.authFailure(connection.name, error); this.failures.set(connection.name, this.clean(error instanceof Error ? error.message : String(error))); } }
        finally { connection.refreshing = undefined; if (this.live(connection)) this.changed(); }
      })();
    }, 100);
  }

  private async request<T>(connection: Connection, signal: AbortSignal | undefined, progress: ((value: ToolProgress) => void) | undefined, operation: (options: RequestOptions) => Promise<T>): Promise<T> {
    this.assertCurrent(connection); const combined = signal ? AbortSignal.any([signal, connection.controller.signal]) : connection.controller.signal;
    let active = true;
    const relay = new McpProgressRelay(progress, () => active && !combined.aborted && this.live(connection), (value) => this.clean(value));
    try {
      combined.throwIfAborted(); const result = await operation({ signal: combined, timeout: this.lifecycle.request_timeout_ms, maxTotalTimeout: this.lifecycle.request_timeout_ms, onprogress: (value) => relay.accept(value) });
      this.assertCurrent(connection); combined.throwIfAborted(); return result;
    } finally { relay.close(!combined.aborted); active = false; }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.listeners.clear();
    for (const connection of this.connections.values()) { connection.desired = false; connection.controller.abort(); if (connection.timer) clearTimeout(connection.timer); if (connection.refreshTimer) clearTimeout(connection.refreshTimer); }
    await this.auth?.close();
    await Promise.all([...this.connections.keys()].map((server) => this.disconnect(server)));
    await this.cache.flush();
    if (this.catalogRegistered) { this.registry.unregister("mcp_resources"); this.registry.unregister("mcp_prompts"); this.catalogRegistered = false; }
  }

  private authFailure(server: string, error: unknown, config = this.configs.get(server)) {
    if (config && (error instanceof UnauthorizedError || error instanceof McpLoginRequired || error && typeof error === "object" && "code" in error && error.code === 401)) this.auth?.required(server, config);
  }
  private buildTransport(name: string, config: McpServerConfig, authProvider?: OAuthClientProvider) {
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
      !authProvider && config.headers && Object.keys(config.headers).length > 0 ? { headers: config.headers } : undefined;
    const authOptions = authProvider ? { authProvider, fetch: this.auth!.transportFetch(config) } : {};
    if (config.transport === "sse") {
      return new SSEClientTransport(url, { ...authOptions, ...(requestInit ? { requestInit } : {}) });
    }
    return new StreamableHTTPClientTransport(url, { ...authOptions, ...(requestInit ? { requestInit } : {}), reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1, maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1 } });
  }

  private wrapTool(connection: Connection, tool: McpToolInfo): AgentTool {
    const { name: serverName, client } = connection, toolName = `mcp__${serverName}__${tool.name}`, fingerprint = catalogHash(tool);
    const validateStructured = tool.outputSchema ? this.validator.getValidator(tool.outputSchema as JsonSchemaType) : undefined;
    return {
      name: toolName,
      description: this.clean(`(MCP server ${serverName}) ${tool.description ?? tool.name}`),
      parameters: z.record(z.string(), z.unknown()),
      parametersJsonSchema: this.clean(tool.inputSchema) as JsonSchemaObject,
      readOnly: false,
      enabled: () => this.live(connection) && !connection.toolsStale,
      execute: async (args, context) => {
        if (!this.live(connection) || connection.toolsStale || connection.schemas.get(tool.name) !== fingerprint) return { status: "unavailable", code: "mcp_catalog_changed", text: "MCP connection or tool definition changed since this request's catalog snapshot. This call was not sent." };
        if (tool.execution?.taskSupport === "required") return { status: "unavailable", code: "mcp_task_required", text: "This MCP tool requires task-based execution, which is not supported by this tool bridge." };
        try {
          context?.signal?.throwIfAborted();
          // Keep known content when a future MCP block is unsupported, while validating the declared structured output below.
          const result = await this.request(connection, context?.signal, context?.onProgress, (options) => client.request({ method: "tools/call", params: { name: tool.name, arguments: args as Record<string, unknown> } }, McpToolResultEnvelopeSchema, options));
          context?.signal?.throwIfAborted();
          return this.clean(mcpToolOutput(result, { server: serverName, tool: tool.name, validateStructured }));
        } catch (error) {
          this.authFailure(serverName, error);
          return this.clean({ status: context?.signal?.aborted ? "cancelled" : "error", code: context?.signal?.aborted ? "mcp_cancelled" : error instanceof McpError && error.code === ErrorCode.RequestTimeout ? "mcp_timeout" : "mcp_request_failed",
            text: error instanceof Error ? error.message : String(error), sources: [{ uri: `mcp://${encodeURIComponent(serverName)}/tools/${encodeURIComponent(tool.name)}`, title: "MCP tool request" }] });
        }
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
