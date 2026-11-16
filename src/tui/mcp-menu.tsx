import React from "react";
import { Box, Text, useInput, useStdin } from "ink";
import type { McpServerConfig } from "../config/loader";
import { isMcpServerName } from "../mcp/names";
import { PromptComposer } from "./composer";
import { isMouseSequence, parseMouseWheel } from "./mouse";
import { fitDisplayText } from "./text-wrap";
import { useActiveTheme, type Theme } from "./theme";
import { McpBrowser, type McpBrowserProps } from "./mcp-browser";
import type { McpCapabilities } from "../mcp/catalog";
import { McpAuthPanel, type McpAuthProps } from "./mcp-auth";
import type { McpAuthStatus } from "../mcp/auth";

export type McpConnectionFields = Pick<McpServerConfig, "transport" | "command" | "args" | "url">;
export interface McpMenuServer extends McpConnectionFields {
  name: string;
  enabled: boolean;
  status: "connected" | "failed" | "disabled" | "disconnected" | "connecting" | "reconnecting";
  tools: string[];
  error?: string;
  capabilities?: McpCapabilities;
  auth?: McpAuthStatus;
  cachedTools?: string[];
  stale?: boolean;
  catalogRevision?: string;
}
export interface McpMenuAction {
  kind: "add" | "configure" | "enable" | "disable" | "reload" | "remove";
  name?: string;
  config?: McpConnectionFields;
}
export interface McpMenuProps {
  servers: McpMenuServer[];
  changing?: boolean;
  width: number;
  height: number;
  theme?: Theme;
  onAction: (action: McpMenuAction) => Promise<void>;
  onClose: () => void;
  onBrowse?: McpBrowserProps["onQuery"];
  onSelectSkill?: McpBrowserProps["onSelectSkill"];
  onAuthenticate?: (server: string, ...args: Parameters<McpAuthProps["onAction"]>) => Promise<string>;
  authServer?: string;
}
type Page = "list" | "name" | "transport" | "address" | "args" | "review" | "remove" | "tools" | "browser" | "auth";
const TRANSPORTS = ["http", "stdio", "sse"] as const;

export function McpMenu(props: McpMenuProps): React.ReactElement {
  const theme = useActiveTheme(props.theme);
  const [selected, setSelected] = React.useState(0);
  const [page, setPage] = React.useState<Page>("list");
  const [name, setName] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const [fields, setFields] = React.useState<McpConnectionFields>({ transport: "http", args: [] });
  const [error, setError] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [toolOffset, setToolOffset] = React.useState(0);
  const [browserKind, setBrowserKind] = React.useState<McpBrowserProps["kind"]>("resources");
  React.useEffect(() => {
    if (!props.authServer || !props.onAuthenticate) return;
    const index = props.servers.findIndex((server) => server.name === props.authServer);
    if (index >= 0) { setSelected(index); setPage("auth"); }
  }, [props.authServer]);
  const currentIndex = Math.max(0, Math.min(selected, props.servers.length - 1));
  const server = props.servers[currentIndex];
  const visibleTools = server?.tools.length ? server.tools : server?.cachedTools ?? [];
  const busy = pending || props.changing;
  const width = Math.max(1, props.width);
  const height = Math.max(6, props.height);
  const listHeight = Math.max(1, height - 6);
  const start = Math.max(0, Math.min(currentIndex - Math.floor(listHeight / 2), props.servers.length - listHeight));
  const line = (text: string) => fitDisplayText(text.replace(/[\r\n]/g, " "), width);
  const move = React.useCallback((delta: number) => {
    if (page === "tools") setToolOffset((value) => Math.max(0, Math.min(Math.max(0, visibleTools.length - listHeight), value + delta)));
    else if (page === "list") setSelected((value) => Math.max(0, Math.min(props.servers.length - 1, Math.min(value, props.servers.length - 1) + delta)));
  }, [page, server, listHeight, props.servers.length, visibleTools.length]);
  const { stdin } = useStdin();
  React.useEffect(() => {
    const listener = (data: Buffer | string) => { const delta = parseMouseWheel(String(data)); if (delta) move(-delta * 3); };
    stdin.on("data", listener);
    return () => { stdin.off("data", listener); };
  }, [stdin, move]);
  const apply = async (action: McpMenuAction) => {
    if (busy) return;
    setPending(true); setError("");
    try { await props.onAction(action); setPage("list"); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setPending(false); }
  };
  const begin = (configure: boolean) => {
    if (busy || configure && !server) return;
    setEditing(configure); setName(configure ? server!.name : "");
    setFields(configure ? { transport: server!.transport, command: server!.command, args: [...server!.args], url: server!.url } : { transport: "http", args: [] });
    setError(""); setPage(configure ? "transport" : "name");
  };
  useInput((input, key) => {
    if (page === "browser" || page === "auth") return;
    if (isMouseSequence(input)) return;
    if (key.escape) { if (page === "list") props.onClose(); else if (!busy) { setPage("list"); setError(""); } return; }
    if (page === "list" && input === "i" && server?.auth && props.onAuthenticate) { setError(""); setPage("auth"); return; }
    if ((page === "list" || page === "tools") && (key.upArrow || key.downArrow)) { move(key.upArrow ? -1 : 1); return; }
    if (busy) return;
    if (page === "transport") {
      const index = TRANSPORTS.indexOf(fields.transport);
      if (key.upArrow || key.downArrow) setFields({ ...fields, transport: TRANSPORTS[(index + (key.upArrow ? 2 : 1)) % 3] });
      else if (key.return) setPage("address");
      return;
    }
    if (page === "review" && key.return) { void apply({ kind: editing ? "configure" : "add", name, config: fields }); return; }
    if (page === "remove" && key.return && server) { void apply({ kind: "remove", name: server.name }); return; }
    if (page !== "list" && page !== "tools") return;
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-listHeight);
    else if (key.pageDown) move(listHeight);
    else if (page === "list") {
      if (input === "a") begin(false);
      else if (input === "c") begin(true);
      else if (input === "r") void apply({ kind: "reload", name: server?.name });
      else if (input === "e" && server) void apply({ kind: server.enabled ? "disable" : "enable", name: server.name });
      else if (input === "x" && server) { setError(""); setPage("remove"); }
      else if (["u", "t", "p"].includes(input) && server && props.onBrowse) {
        const kind = input === "u" ? "resources" : input === "t" ? "templates" : "prompts";
        if (!server.capabilities?.[kind === "templates" ? "resources" : kind]) { setError(`Server does not provide ${kind}.`); return; }
        setError(""); setBrowserKind(kind); setPage("browser");
      }
      else if (key.return && server) { setToolOffset(0); setPage("tools"); }
    }
  });
  const form = page === "name" || page === "address" || page === "args";
  const title = page === "name" ? "Server name" : page === "address" ? fields.transport === "stdio" ? "Executable" : "Server URL" : "Arguments as a JSON array";
  const initial = page === "address" ? fields.transport === "stdio" ? fields.command ?? "" : fields.url ?? "" : page === "args" ? JSON.stringify(fields.args) : name;
  if (page === "browser" && server && props.onBrowse) return <McpBrowser server={server.name} kind={browserKind} width={width} height={height} theme={theme}
    revision={server.catalogRevision} stale={server.stale} onQuery={props.onBrowse} onSelectSkill={props.onSelectSkill} onClose={() => setPage("list")} />;
  if (page === "auth" && server?.auth && props.onAuthenticate) return <McpAuthPanel server={server.name} status={server.auth} width={width} height={height} theme={theme}
    onAction={(...args) => props.onAuthenticate!(server.name, ...args)} onClose={() => setPage("list")} />;
  return <Box flexDirection="column" width={width} height={height} overflow="hidden">
    <Text bold color={theme.accent} wrap="truncate">{line(`MCP · ${page === "list" ? props.onAuthenticate ? "Servers · i auth" : "Servers" : page === "tools" ? `${server?.name ?? "Server"} tools` : editing ? `Configure ${name}` : "Add server"}`)}</Text>
    <Text color={theme.muted} wrap="truncate">{line(busy ? "Updating connections…" : "Connect or change servers when idle.")}</Text>
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {page === "list" ? <>
        {!props.servers.length ? <Text color={theme.text}>No servers configured. Press a to add.</Text> : null}
        {props.servers.slice(start, start + listHeight).map((entry, index) => <Text key={entry.name} color={start + index === currentIndex ? theme.selection : theme.text} bold={start + index === currentIndex} wrap="truncate">
          {line(`${start + index === currentIndex ? "❯" : " "} ${entry.name} · ${entry.status} · ${entry.tools.length} tools`)}
        </Text>)}
        {server ? <Text color={theme.muted} wrap="truncate">{line(props.onBrowse && server.capabilities ? [server.capabilities.resources ? "u resources · t templates" : "", server.capabilities.prompts ? "p prompts" : ""].filter(Boolean).join(" · ") || "No resources or prompts." : `${server.transport} · ${server.enabled ? "enabled" : "disabled"}`)}</Text> : null}
        {server?.error ? <Text color={theme.status.error} wrap="truncate">{line(server.error)}</Text> : null}
      </> : page === "tools" ? <>
        {server?.stale && visibleTools.length ? <Text color={theme.muted} wrap="truncate">{line("Cached metadata · stale · not callable")}</Text> : null}
        {!visibleTools.length ? <Text color={theme.muted}>No connected tools.</Text> : null}
        {visibleTools.slice(toolOffset, toolOffset + listHeight).map((tool) => <Text key={tool} color={theme.text} wrap="truncate">{line(tool)}</Text>)}
      </> : page === "transport" ? TRANSPORTS.map((transport) => <Text key={transport} color={transport === fields.transport ? theme.selection : theme.text} wrap="truncate">{transport === fields.transport ? "❯" : " "} {transport}</Text>) : form ? <>
        <Text color={theme.text} wrap="truncate">{title}</Text>
        <PromptComposer key={`${page}-${name}`} width={width} maxHeight={Math.max(4, height - 5)} maxRows={2} theme={theme}
          initialText={initial} hint="Enter next · Esc cancel" placeholder={page === "name" ? "browser" : page === "args" ? "[]" : fields.transport === "stdio" ? "Executable path or command" : "https://…"}
          disabled={busy} onSubmit={({ rawText }) => {
            try {
              if (page === "name") {
                const next = rawText.trim();
                if (!isMcpServerName(next)) throw new Error("Use letters, numbers, _ or -; reserved names are unavailable.");
                if (props.servers.some((entry) => entry.name === next)) throw new Error("That server already exists. Use c to configure.");
                setName(next); setPage("transport");
              } else if (page === "address") {
                const value = rawText.trim();
                if (!value) throw new Error("Enter a connection value.");
                if (fields.transport === "stdio") { setFields({ ...fields, command: value, url: undefined }); setPage("args"); }
                else {
                  const url = new URL(value);
                  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use an HTTP or HTTPS URL.");
                  setFields({ ...fields, url: value, command: undefined, args: [] }); setPage("review");
                }
              } else {
                const args: unknown = JSON.parse(rawText);
                if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) throw new Error("Use a JSON array of strings.");
                setFields({ ...fields, args }); setPage("review");
              }
              setError(""); return true;
            } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return false; }
          }} />
      </> : <>
        <Text color={theme.text} wrap="truncate">{line(page === "remove" ? `Remove ${server?.name} from config?` : `${name} · ${fields.transport}`)}</Text>
        {page === "review" ? <Text color={theme.text} wrap="truncate">{line(fields.transport === "stdio" ? `Executable: ${fields.command} · ${fields.args.length} arguments` : `Server: ${new URL(fields.url!).origin}${new URL(fields.url!).pathname}`)}</Text> : null}
        <Text color={theme.muted} wrap="truncate">{line(page === "remove" ? "The server program is kept on disk." : "Enter saves settings and connects if enabled.")}</Text>
      </>}
    </Box>
    {error ? <Text color={theme.status.error} wrap="truncate">{line(error)}</Text> : null}
    <Text color={theme.muted} wrap="truncate">{line(page === "list" ? width < 60 ? "↑/↓ · Enter tools · e toggle · r reload" : "↑/↓ Wheel · Enter tools · e toggle · r reload" : page === "review" || page === "remove" ? "Enter confirm · Esc cancel" : page === "transport" ? "↑/↓ select · Enter next · Esc cancel" : "Esc back")}</Text>
    {page === "list" ? <Text color={theme.muted} wrap="truncate">{line(width < 60 ? "a add · c edit · x remove · Esc close" : "a add · c configure · x remove · Esc close")}</Text> : null}
  </Box>;
}
