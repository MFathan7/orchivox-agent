import React from "react";
import { Box, Text, useInput, useStdin } from "ink";
import type { McpAuthStatus } from "../mcp/auth";
import { isMouseSequence, parseMouseWheel } from "./mouse";
import { fitDisplayText, wrapPreservingWhitespace } from "./text-wrap";
import type { Theme } from "./theme";

export type McpAuthAction = "login" | "logout" | "refresh" | "cancel" | "open";
export interface McpAuthProps {
  server: string; status: McpAuthStatus; width: number; height: number; theme: Theme;
  onAction: (action: McpAuthAction, storage?: "native" | "session", signal?: AbortSignal) => Promise<string>;
  onClose: () => void;
}
export function McpAuthPanel(props: McpAuthProps): React.ReactElement {
  const { status, theme } = props;
  const [storage, setStorage] = React.useState<"native" | "session">(status.storage === "none" ? status.nativeAvailable ? "native" : "session" : status.storage);
  React.useEffect(() => { if (status.storage !== "none") setStorage(status.storage); }, [status.storage]);
  const [pending, setPending] = React.useState(false), [confirmLogout, setConfirmLogout] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [offset, setOffset] = React.useState(0);
  const active = React.useRef<AbortController>();
  const statusRef = React.useRef(status); statusRef.current = status;
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; active.current?.abort(); if (statusRef.current.state === "authorizing") void props.onAction("cancel").catch(() => {}); }, []);
  const busy = pending || status.state === "authorizing";
  const width = Math.max(1, props.width), height = Math.max(6, props.height), count = Math.max(1, height - 5);
  const content = status.state === "manual" ? "This server uses stdio or a manual Authorization header. OAuth login does not replace those credentials.\nDisconnect keeps manual settings; manage them through your configuration."
    : confirmLogout ? "Delete saved OAuth credentials for this server and disconnect?\nManual headers/env and remote service grants are kept.\nEnter confirms. Escape cancels."
      : status.authorizationUrl ? `Open the sign-in page with o, or open this URL yourself:\n${status.authorizationUrl}\nThe callback listens only on this computer's loopback interface. Escape cancels login.`
        : [`Storage choice: ${storage === "native" ? status.nativeLabel : "Memory only (cleared on exit)"}`,
          `Native: ${status.nativeAvailable ? "CLI detected; vault access checked on use" : "unavailable on this system"}.`,
          "No plaintext file fallback. Tab changes storage before login.",
          ...(status.scope ? [`Granted scope: ${status.scope}`] : []),
          ...(status.expiresAt ? [`Expires: ${new Date(status.expiresAt).toLocaleString()}`] : []),
          "Disconnect keeps saved credentials. Logout deletes local OAuth credentials; remote grants belong to the service.",
        ].join("\n");
  const lines = wrapPreservingWhitespace(message ? `${message}\n\n${content}` : content, width);
  const move = React.useCallback((delta: number) => setOffset((value) => Math.max(0, Math.min(Math.max(0, lines.length - count), value + delta))), [lines.length, count]);
  const { stdin } = useStdin();
  React.useEffect(() => {
    const listener = (data: Buffer | string) => { const delta = parseMouseWheel(String(data)); if (delta) move(-delta * 3); };
    stdin.on("data", listener); return () => { stdin.off("data", listener); };
  }, [stdin, move]);
  React.useEffect(() => { setOffset(0); }, [status.authorizationUrl]);
  const apply = async (action: McpAuthAction) => {
    if (pending) return;
    const controller = new AbortController(); active.current = controller; setPending(true); setMessage(""); setConfirmLogout(false); setOffset(0);
    try { const text = await props.onAction(action, action === "login" ? storage : undefined, controller.signal); if (!controller.signal.aborted) setMessage(text); }
    catch (error) { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (!controller.signal.aborted) setPending(false); }
  };
  useInput((input, key) => {
    if (isMouseSequence(input)) return;
    if (key.escape) {
      if (confirmLogout) { setConfirmLogout(false); return; }
      active.current?.abort(); if (status.state === "authorizing") void props.onAction("cancel").catch(() => {}); props.onClose(); return;
    }
    if (key.upArrow) move(-1); else if (key.downArrow) move(1); else if (key.pageUp) move(-count); else if (key.pageDown) move(count);
    else if (input === "o" && status.authorizationUrl) void props.onAction("open").catch((error) => { if (mounted.current) setMessage(error instanceof Error ? error.message : String(error)); });
    else if (busy || status.state === "manual") return;
    else if (confirmLogout) { if (key.return) void apply("logout"); }
    else if (key.tab && status.nativeAvailable) { setStorage((value) => value === "native" ? "session" : "native"); setOffset(0); }
    else if (key.return || input === "l") void apply("login");
    else if (input === "r") void apply("refresh");
    else if (input === "x") { setConfirmLogout(true); setOffset(0); }
  });
  const line = (text: string) => fitDisplayText(text, width);
  const start = Math.min(offset, Math.max(0, lines.length - count));
  return <Box flexDirection="column" width={width} height={height} overflow="hidden">
    <Text bold color={theme.accent} wrap="truncate">{line(`MCP · ${props.server} · Authentication`)}</Text>
    <Text color={theme.text} wrap="truncate">{line(`Status: ${status.state}${status.storage !== "none" ? ` · ${status.storage}` : ""}${pending ? " · working" : ""}`)}</Text>
    <Box flexDirection="column" flexGrow={1} overflow="hidden">{lines.slice(start, start + count).map((text, index) => <Text key={index} color={theme.text} wrap="truncate">{text || " "}</Text>)}</Box>
    <Text color={theme.muted} wrap="truncate">{line(`↑/↓ Wheel · ${start + 1}-${Math.min(start + count, lines.length)} / ${lines.length}`)}</Text>
    <Text color={theme.muted} wrap="truncate">{line(status.authorizationUrl ? "o open browser · Esc cancel login" : busy ? "Esc cancel" : confirmLogout ? "Enter delete · Esc back" : status.state === "manual" ? "Esc back" : "Tab storage · Enter login · r refresh")}</Text>
    <Text color={theme.muted} wrap="truncate">{line(status.state === "manual" ? "Manual settings remain in config." : busy ? "No token needs to be pasted into chat." : confirmLogout ? "Removes local OAuth credentials." : "x logout · Esc back · no token in chat")}</Text>
  </Box>;
}
