import React from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type { McpCatalogItem, McpCatalogQuery, McpCatalogView } from "../mcp/catalog";
import { PromptComposer } from "./composer";
import { isMouseSequence, parseMouseWheel } from "./mouse";
import { fitDisplayText, wrapPreservingWhitespace } from "./text-wrap";
import type { Theme } from "./theme";

export interface McpBrowserProps {
  server: string; kind: "resources" | "templates" | "prompts"; width: number; height: number; theme: Theme;
  onQuery: (query: McpCatalogQuery, signal: AbortSignal) => Promise<McpCatalogView>;
  onSelectSkill?: (server: string, uri: string, signal: AbortSignal) => Promise<string>;
  onClose: () => void;
  revision?: string;
  stale?: boolean;
}

export function McpBrowser(props: McpBrowserProps): React.ReactElement {
  const { server, kind, theme } = props;
  const width = Math.max(1, props.width), height = Math.max(6, props.height), count = Math.max(1, height - 5);
  const [view, setView] = React.useState<McpCatalogView>();
  const [selected, setSelected] = React.useState(0);
  const [preview, setPreview] = React.useState<string>();
  const [form, setForm] = React.useState<McpCatalogItem>();
  const [offset, setOffset] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [stale, setStale] = React.useState(props.stale === true);
  React.useEffect(() => { setStale(true); }, [props.revision, props.stale]);
  const [cursors, setCursors] = React.useState<Array<string | undefined>>([undefined]);
  const active = React.useRef<AbortController | undefined>(undefined);
  const queryRef = React.useRef(props.onQuery); queryRef.current = props.onQuery;
  const lastQuery = React.useRef<McpCatalogQuery>();
  const listQuery = (cursor?: string): McpCatalogQuery => kind === "prompts" ? { kind: "prompts", server, action: "list", cursor } : { kind: "resources", server, action: kind === "templates" ? "templates" : "list", cursor };
  const load = async (query: McpCatalogQuery, reading = false) => {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller; lastQuery.current = query;
    setLoading(true); setError(""); setForm(undefined);
    try {
      const result = await queryRef.current(query, controller.signal);
      if (controller.signal.aborted) return;
      if (reading) { setPreview(result.text); setOffset(0); }
      else { setView(result); setSelected(0); setPreview(undefined); setStale(result.stale === true); }
      if (["error", "unavailable", "cancelled"].includes(result.status)) setError(result.status);
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  React.useEffect(() => {
    void load(listQuery());
    return () => { active.current?.abort(); };
  }, [server, kind]);
  const lines = React.useMemo(() => preview === undefined ? [] : wrapPreservingWhitespace(preview, width), [preview, width]);
  const items = view?.items ?? [], item = items[selected];
  const move = React.useCallback((delta: number) => {
    if (preview !== undefined) setOffset((value) => Math.max(0, Math.min(Math.max(0, lines.length - count), value + delta)));
    else setSelected((value) => Math.max(0, Math.min(items.length - 1, value + delta)));
  }, [preview, lines.length, count, items.length]);
  const { stdin } = useStdin();
  React.useEffect(() => {
    const listener = (data: Buffer | string) => { const delta = parseMouseWheel(String(data)); if (delta && !form && !loading) move(-delta * 3); };
    stdin.on("data", listener); return () => { stdin.off("data", listener); };
  }, [stdin, move, form, loading]);
  useInput((input, key) => {
    if (isMouseSequence(input)) return;
    if (key.escape) {
      active.current?.abort(); setLoading(false); setError("");
      if (form) setForm(undefined); else if (preview !== undefined) setPreview(undefined); else props.onClose();
      return;
    }
    if (loading || form) return;
    if (key.upArrow) move(-1); else if (key.downArrow) move(1);
    else if (key.pageUp) move(-count); else if (key.pageDown) move(count);
    else if (input === "r") void load(lastQuery.current ?? listQuery(), preview !== undefined);
    else if (preview !== undefined) return;
    else if (input === "n" && view?.nextCursor !== undefined) {
      if (cursors.includes(view.nextCursor)) { setError("Server repeated a page cursor. Press r to retry."); return; }
      setCursors([...cursors, view.nextCursor]); void load(listQuery(view.nextCursor));
    } else if (input === "b" && cursors.length > 1) {
      const previous = cursors.slice(0, -1); setCursors(previous); void load(listQuery(previous.at(-1)));
    } else if (key.return && item) {
      if (kind === "resources" && item.uri) void load({ kind: "resources", server, action: "read", uri: item.uri }, true);
      else setForm(item);
    } else if (input === "s" && kind === "resources" && item?.uri && props.onSelectSkill) {
      active.current?.abort();
      const controller = new AbortController(); active.current = controller;
      setLoading(true); setError("");
      void props.onSelectSkill(server, item.uri, controller.signal).then((text) => { if (!controller.signal.aborted) { setPreview(text); setOffset(0); } }, (failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }
  });
  const line = (text: string) => fitDisplayText(text.replace(/[\r\n]/g, " "), width);
  const start = Math.max(0, Math.min(selected - Math.floor(count / 2), items.length - count));
  const fields = form ? kind === "templates" ? (() => { try { return new UriTemplate(form.uriTemplate!).variableNames.join(", "); } catch { return "Invalid URI template"; } })() : (form.arguments ?? []).map((arg) => `${arg.name}${arg.required ? " (required)" : ""}`).join(", ") : "";
  return <Box flexDirection="column" width={width} height={height} overflow="hidden">
    <Text bold color={theme.accent} wrap="truncate">{line(`MCP · ${server} · ${kind}`)}</Text>
    <Text color={theme.muted} wrap="truncate">{line(loading ? "Loading from server… Esc cancels" : stale ? "Catalog stale · r reload · existing access" : "External content · existing permissions apply")}</Text>
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {form ? <>
        <Text color={theme.text} wrap="truncate">{line(form.uriTemplate ?? form.name)}</Text>
        <Text color={theme.muted} wrap="truncate">{line(fields ? `JSON values: ${fields}` : "No arguments required. Enter {} to fetch.")}</Text>
        <PromptComposer width={width} maxHeight={Math.max(4, height - 6)} maxRows={2} theme={theme} initialText="{}" placeholder="JSON arguments" hint="Enter fetch · Esc back"
          onSubmit={({ rawText }) => {
            try {
              const values: unknown = JSON.parse(rawText);
              if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Enter a JSON object.");
              if (kind === "prompts" && !Object.values(values).every((value) => typeof value === "string")) throw new Error("Prompt arguments must be strings.");
              if (kind === "templates" && !Object.values(values).every((value) => typeof value === "string" || Array.isArray(value) && value.every((entry) => typeof entry === "string"))) throw new Error("Template values must be strings or string arrays.");
              void load(kind === "prompts" ? { kind: "prompts", server, action: "get", name: form.name, arguments: values as Record<string, string> }
                : { kind: "resources", server, action: "read", uriTemplate: form.uriTemplate, variables: values as Record<string, string | string[]> }, true);
              return true;
            } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return false; }
          }} />
      </> : preview !== undefined ? lines.slice(Math.min(offset, Math.max(0, lines.length - count)), Math.min(offset, Math.max(0, lines.length - count)) + count).map((text, index) => <Text key={index} color={theme.text} wrap="truncate">{text || " "}</Text>)
        : items.length ? items.slice(start, start + count).map((entry, index) => <Text key={`${start + index}`} color={start + index === selected ? theme.selection : theme.text} wrap="truncate">{line(`${start + index === selected ? "❯" : " "} ${entry.name} · ${entry.uri ?? entry.uriTemplate ?? entry.description ?? "prompt"}`)}</Text>)
          : !loading ? wrapPreservingWhitespace(error || (view?.status === "empty" ? `No ${kind} returned for this page. Press r to reload.` : view?.text ?? "Listing failed. Press r to retry."), width).slice(0, count).map((text, index) => <Text key={index} color={error ? theme.status.error : theme.muted} wrap="truncate">{text}</Text>) : null}
    </Box>
    <Text color={error ? theme.status.error : theme.muted} wrap="truncate">{line(error || (preview !== undefined ? `${Math.min(offset + 1, lines.length)}-${Math.min(offset + count, lines.length)} / ${lines.length} lines` : `${items.length} entries · page ${cursors.length}${view?.nextCursor !== undefined ? " · n next" : ""}`))}</Text>
    <Text color={theme.muted} wrap="truncate">{line(preview !== undefined ? "↑/↓ Wheel · r retry · Esc back" : form ? "Enter fetch · Esc back" : "↑/↓ · Enter open · n/b page · Esc back")}</Text>
    <Text color={theme.muted} wrap="truncate">{line(kind === "resources" && preview === undefined && !form && props.onSelectSkill ? "s select as skill · r reload list" : "Fetches only the selected content.")}</Text>
  </Box>;
}
