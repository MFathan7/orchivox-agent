import { readFile } from "node:fs/promises";
import { McpServerConfigSchema, parseConfigText, type McpServerConfig } from "../config/loader";
import { saveMcpServer } from "../config/writer";
import { redactSecrets } from "../security/secrets";
import type { McpClientManager } from "./client";
import { isMcpServerName } from "./names";
import { normalizeToolOutput, toolResultText } from "../tools/result";
import { PromptQuerySchema, ResourceQuerySchema, type McpCatalogQuery, type McpCatalogView } from "./catalog";
import type { AgentMode } from "../types/schema";

export const MCP_HELP = [
  "/mcp                    Connection status",
  "/mcp tools <name>       List server tools",
  "/mcp resources <name> [cursor]  List resource metadata",
  "/mcp templates <name> [cursor]  List URI templates",
  "/mcp read <name> <URI or JSON>  Read one resource",
  "/mcp prompts <name> [cursor]    List prompt metadata",
  "/mcp prompt <name> <JSON>       Get {\"name\":\"…\",\"arguments\":{}}",
  "/mcp skill <name> <URI>         Select a resource skill for this runtime",
  "/mcp auth <name>               Authentication status and storage options",
  "/mcp login <name> native|session  Start sign-in with chosen storage",
  "/mcp open <name>               Open the pending sign-in page",
  "/mcp cancel <name>             Cancel pending sign-in",
  "/mcp logout <name>             Disconnect and delete saved OAuth credentials",
  "/mcp refresh <name>            Refresh saved OAuth credentials",
  "/mcp add <name> <url>   Add an HTTP server",
  '/mcp add <name> <JSON>  Add config, e.g. {"command":"my-server","args":[]}',
  "/mcp enable <name>      Save enabled and connect",
  "/mcp disable <name>     Save disabled and disconnect",
  "/mcp remove <name>      Remove from config and disconnect",
  "/mcp reload [name]      Reconnect using the config file",
  "/mcp configure <name> <JSON>  Update connection settings",
  "Changes require idle main/worker/side tasks. PLAN keeps MCP tools unavailable.",
].join("\n");

export const MCP_CONNECTION_ACTIONS = new Set(["add", "configure", "enable", "disable", "remove", "reload", "login", "logout", "refresh"]);

export async function mcpCatalogView(query: McpCatalogQuery, options: { manager: McpClientManager; mode?: AgentMode; root?: string; signal?: AbortSignal }): Promise<McpCatalogView> {
  if (options.mode === "plan") throw new Error("MCP resources and prompts are unavailable in PLAN mode. Switch to BUILD to browse them.");
  const output = await options.manager.query(query, options.signal);
  const result = await normalizeToolOutput(crypto.randomUUID(), output, { root: options.root ?? process.cwd() });
  const data = result.outcome?.data as { items?: McpCatalogView["items"]; nextCursor?: string } | undefined;
  const catalog = (result.metadata?.ui as Record<string, unknown> | undefined)?.mcp_catalog as { stale?: boolean } | undefined;
  return { text: toolResultText(result), status: result.outcome!.status, items: data?.items ?? [], stale: catalog?.stale, ...(data?.nextCursor !== undefined ? { nextCursor: data.nextCursor } : {}) };
}

export async function mcpCommand(raw: string, options: {
  manager: McpClientManager;
  servers: Record<string, McpServerConfig>;
  configPath: string;
  busy: boolean;
  mode?: AgentMode;
  root?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const match = /^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/.exec(raw.trim());
  const action = match?.[1] ?? "list";
  const name = match?.[2];
  const value = match?.[3];
  const { manager, servers, configPath } = options;
  const status = () => ["MCP servers", ...Object.entries(servers).map(([id, config]) =>
    `${id}: ${!config.enabled ? "disabled" : manager.listServers().includes(id) ? `connected · ${manager.toolNames(id).length} tools${manager.status(id).stale ? " · catalog stale" : ""}` : manager.status(id).phase}${manager.status(id).stale && manager.status(id).cachedTools.length ? ` · ${manager.status(id).cachedTools.length} cached tools (stale; unavailable)` : ""}`),
    ...(Object.keys(servers).length ? [] : ["No servers configured."]), "", MCP_HELP].join("\n");
  if (action === "list" || action === "help") return status();
  if (["auth", "login", "logout", "refresh", "cancel", "open"].includes(action)) {
    if (!name || !Object.hasOwn(servers, name)) throw new Error("Specify a configured MCP server.");
    if (action === "auth") {
      const auth = manager.authStatus(name, servers[name]);
      if (!auth) return "OAuth is unavailable in this MCP host.";
      return [`Authentication for ${name}: ${auth.state}`, `Native storage: ${auth.nativeLabel} (${auth.nativeAvailable ? "detected; access checked on use" : "unavailable"})`,
        "Memory-only storage: cleared on process exit. No plaintext file fallback.", ...(auth.scope ? [`Granted scope: ${auth.scope}`] : []),
        "Use the authentication menu to view a pending sign-in URL. Disconnect keeps credentials; logout deletes local OAuth credentials."].join("\n");
    }
    if (!["cancel", "open"].includes(action) && options.busy) throw new Error("Wait for active tasks before changing MCP authentication.");
    if (action === "login" && value !== "native" && value !== "session") return "Choose storage before login: /mcp login <server> native or session. Native uses the OS credential store; session keeps credentials only until exit. Use /mcp auth <server> to check availability. No plaintext fallback.";
    return manager.authenticate(name, servers[name], action as "login" | "logout" | "refresh" | "cancel" | "open", value as "native" | "session" | undefined, options.signal);
  }
  if (action === "tools") {
    if (!name || !Object.hasOwn(servers, name)) throw new Error("Specify a configured MCP server: /mcp tools <name>");
    return [`Tools for ${name}`, ...manager.toolNames(name), ...(manager.failure(name) ? [`Connection failed: ${redactSecrets(manager.failure(name)!)}`] : []),
      ...(!manager.toolNames(name).length && manager.status(name).cachedTools.length ? ["Cached metadata (stale; not callable):", ...manager.status(name).cachedTools] : []),
      manager.toolNames(name).length ? "" : "No connected tools."].join("\n");
  }
  if (["resources", "templates", "read", "prompts", "prompt"].includes(action)) {
    if (!name || !Object.hasOwn(servers, name)) throw new Error("Specify a configured MCP server.");
    let query: McpCatalogQuery;
    if (action === "resources" || action === "templates") query = { kind: "resources", ...ResourceQuerySchema.parse({ server: name, action: action === "resources" ? "list" : "templates", cursor: value }) };
    else if (action === "read") query = { kind: "resources", ...ResourceQuerySchema.parse({ ...(value?.startsWith("{") ? JSON.parse(value) : { uri: value }), server: name, action: "read" }) };
    else query = { kind: "prompts", ...PromptQuerySchema.parse({ ...(action === "prompt" ? JSON.parse(value ?? "{}") : { cursor: value }), server: name, action: action === "prompt" ? "get" : "list" }) };
    return (await mcpCatalogView(query, options)).text;
  }
  if (action === "skill") {
    if (options.mode === "plan") throw new Error("MCP resource skills are unavailable in PLAN mode.");
    if (options.busy) throw new Error("Wait for active tasks before selecting a resource skill.");
    if (!name || !value) throw new Error("Use /mcp skill <server> <resource URI>.");
    return manager.selectSkill(name, value, options.signal);
  }
  if (!MCP_CONNECTION_ACTIONS.has(action)) throw new Error("Unknown MCP action. Use /mcp help.");
  if (options.busy) throw new Error("Wait for active main, worker and side tasks to finish before changing MCP connections.");
  if (action === "reload") {
    const mcp = parseConfigText(await readFile(configPath, "utf8"), configPath).mcp, loaded = mcp.servers;
    manager.configureLifecycle(mcp.lifecycle);
    if (name && !Object.hasOwn(loaded, name) && !Object.hasOwn(servers, name)) throw new Error(`Unknown MCP server: ${name}`);
    const ids = name ? [name] : [...new Set([...Object.keys(servers), ...Object.keys(loaded)])];
    for (const id of ids) {
      await manager.disconnect(id);
      if (Object.hasOwn(loaded, id)) servers[id] = loaded[id];
      else delete servers[id];
    }
    const report = await manager.connectAll(Object.fromEntries(ids.filter((id) => Object.hasOwn(servers, id)).map((id) => [id, servers[id]])));
    return [status(), ...report.failed.map((entry) => `${entry.server}: ${redactSecrets(entry.error)}`)].join("\n");
  }
  if (!name || !isMcpServerName(name)) throw new Error("Use a non-reserved server name containing letters, numbers, _ or -.");
  if (action === "add" || action === "configure") {
    if (action === "add" && Object.hasOwn(servers, name)) throw new Error(`MCP server ${name} already exists. Use /mcp configure ${name} <JSON>.`);
    if (action === "configure" && !Object.hasOwn(servers, name)) throw new Error(`Unknown MCP server: ${name}`);
    if (!value) throw new Error("Provide a server URL or JSON config.");
    const patch = value.startsWith("{") ? JSON.parse(value) : { transport: "http", url: value };
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("MCP config must be an object.");
    const config = McpServerConfigSchema.parse({ ...(action === "configure" ? servers[name] : {}), ...patch });
    await saveMcpServer(configPath, name, config);
    if (action === "configure") await manager.disconnect(name);
    servers[name] = config;
  } else {
    if (!Object.hasOwn(servers, name)) throw new Error(`Unknown MCP server: ${name}`);
    const config = action === "remove" ? undefined : { ...servers[name], enabled: action === "enable" };
    await saveMcpServer(configPath, name, config);
    await manager.disconnect(name);
    if (config) servers[name] = config;
    else delete servers[name];
  }
  if (servers[name]?.enabled) await manager.connectAll({ [name]: servers[name] });
  return [status(), ...(manager.failure(name) ? [`${name}: ${redactSecrets(manager.failure(name)!)}`] : [])].join("\n");
}
