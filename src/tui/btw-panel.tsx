import React from "react";
import { Box, Text, useInput, useStdin } from "ink";
import type { BtwTurn } from "../agent/btw";
import { DEFAULT_UI_LAYOUT, type UiLayout } from "../types/ui-layout";
import { PromptComposer, type FileAttachmentRef } from "./composer";
import { TranscriptRowIndex } from "./transcript-lines";
import type { ChatEntryView } from "./app";
import { formatElapsed, formatTokenCount, formatCost } from "./format";
import { isMouseSequence, parseMouseWheel } from "./mouse";
import { useActiveTheme, type Theme } from "./theme";
import { wrapText } from "./text-wrap";
import { LAYOUT_PRESETS } from "./layout";
import { LiveStatus } from "./spinner";

export interface BtwPanelProps {
  active?: boolean;
  turns: BtwTurn[];
  topicId?: string;
  width: number;
  height: number;
  layout?: UiLayout;
  theme?: Theme;
  onSelect: (topicId: string) => void;
  onFollowup: (topicId: string, question: string, attachments?: FileAttachmentRef[]) => boolean;
  onCancel: () => void;
  onClose: () => void;
}

export function BtwPanel(props: BtwPanelProps): React.ReactElement {
  const theme = useActiveTheme(props.theme);
  const layout = props.layout ?? DEFAULT_UI_LAYOUT;
  const preset = LAYOUT_PRESETS[layout];
  const topics = [...new Set(props.turns.map((turn) => turn.topicId))];
  const selected = props.topicId && topics.includes(props.topicId) ? props.topicId : topics.at(-1);
  const turns = props.turns.filter((turn) => turn.topicId === selected);
  const latest = turns.at(-1);
  const activeTurn = props.turns.find((turn) => turn.status === "running");
  const active = Boolean(activeTurn);
  const [editing, setEditing] = React.useState(false);
  const [composerRows, setComposerRows] = React.useState(4);
  const [offset, setOffset] = React.useState<number | undefined>();
  const entryCache = React.useRef(new WeakMap<BtwTurn, ChatEntryView[]>());
  const rows = React.useMemo(() => new TranscriptRowIndex(turns.flatMap((turn) => {
    const cached = entryCache.current.get(turn);
    if (cached) return cached;
    const entries: ChatEntryView[] = [
      { id: `${turn.id}-question`, role: "user", text: turn.question },
      { id: `${turn.id}-answer`, role: "assistant", live: turn.status === "running", text: turn.answer || (turn.status === "running" ? "" : "No answer text."),
        ...(turn.error ? { text: `${turn.answer}\n\n${turn.error}` } : {}) },
      ...(turn.status !== "complete" && turn.status !== "running" || turn.finishReason === "length" ? [{ id: `${turn.id}-status`, role: "system" as const,
        text: `Side answer: ${turn.status}${turn.finishReason === "length" ? " (output limit reached)" : ""}` }] : []),
    ];
    entryCache.current.set(turn, entries);
    return entries;
  }), { width: Math.max(1, props.width), theme, layout, collapsed: false, expandedGroups: new Set<string>(), thinkingExpanded: false }), [props.turns, selected, props.width, theme, layout]);
  const hintLines = (editing ? active ? ["Ctrl+X stop side answer"] : [] : [
    "←/→ topics · ↑/↓ scroll",
    "Wheel/PgUp/PgDn · End follow",
    `${selected ? "f reply · " : ""}${active ? "x stop active · " : ""}Esc close`,
  ]).flatMap((line) => wrapText(line, Math.max(1, props.width)));
  const usage = latest?.usage;
  const footer = latest ? [latest.status, latest.finishReason === "length" ? "output limit reached" : "", latest.durationMs === undefined ? "" : formatElapsed(latest.durationMs / 1000),
    usage && usage.prompt_tokens + usage.completion_tokens > 0 ? `${formatTokenCount(usage.prompt_tokens + usage.completion_tokens)} tokens` : "", usage?.cost_usd === undefined ? "" : formatCost(usage.cost_usd), usage?.cost_incomplete ? "usage incomplete" : ""].filter(Boolean).join(" · ") : "Ask /btw <question> to start.";
  const footerLines = wrapText(footer, Math.max(1, props.width));
  const showActivity = props.active !== false && activeTurn?.topicId === selected;
  const bodyHeight = Math.max(1, props.height - 1 - footerLines.length - hintLines.length - (editing ? composerRows : 0) - (showActivity ? 1 : 0));
  const maxOffset = Math.max(0, rows.length - bodyHeight);
  const current = Math.max(0, Math.min(offset ?? maxOffset, maxOffset));
  const scroll = React.useCallback((delta: number) => setOffset((value) => Math.max(0, Math.min(maxOffset, (value ?? maxOffset) + delta))), [maxOffset]);
  const { stdin } = useStdin();
  React.useEffect(() => {
    const listener = (data: Buffer | string) => {
      if (editing) return;
      const raw = String(data);
      const delta = parseMouseWheel(raw);
      if (delta) scroll(-delta * 3);
      else if (["\x1b[F", "\x1b[4~", "\x1b[8~", "\x1bOF"].includes(raw)) setOffset(undefined);
    };
    if (props.active === false) return;
    stdin.on("data", listener);
    return () => { stdin.off("data", listener); };
  }, [stdin, scroll, editing, props.active]);
  React.useEffect(() => { setOffset(undefined); setEditing(false); }, [selected]);
  useInput((input, key) => {
    if (isMouseSequence(input)) return;
    if (key.ctrl && input === "x" && active) { props.onCancel(); return; }
    if (key.escape) { if (editing) setEditing(false); else props.onClose(); return; }
    if (editing) return;
    if (key.upArrow) scroll(-1);
    else if (key.downArrow) scroll(1);
    else if (key.pageUp) scroll(-bodyHeight);
    else if (key.pageDown) scroll(bodyHeight);
    else if ((key as { end?: boolean }).end) setOffset(undefined);
    else if (key.leftArrow || key.rightArrow) {
      const index = topics.indexOf(selected ?? "");
      const next = topics[index + (key.leftArrow ? -1 : 1)];
      if (next) props.onSelect(next);
    } else if (input === "f" && selected) setEditing(true);
    else if (input === "x" && active) props.onCancel();
  }, { isActive: props.active !== false });
  return <Box flexDirection="column" width={props.width} height={props.height} overflow="hidden">
    <Text color={theme.accent} bold wrap="truncate">Side conversation · {Math.max(0, topics.indexOf(selected ?? "") + 1)}/{topics.length}{active ? activeTurn?.topicId === selected ? " · answering" : " · another topic answering" : ""}</Text>
    <Box flexDirection="column" height={bodyHeight} overflow="hidden">
      {!turns.length ? <Text color={theme.text}>No side conversations yet.</Text> : null}
      {rows.slice(current, current + bodyHeight).map((row) => <React.Fragment key={row.key}>{row.node}</React.Fragment>)}
    </Box>
    {showActivity ? <LiveStatus active answering={Boolean(activeTurn?.answer)} completedTools={0} indicator={preset.activity} width={props.width} /> : null}
    {footerLines.map((line, index) => <Text key={`footer-${index}`} color={theme.muted}>{line}</Text>)}
    {editing && selected ? <PromptComposer width={props.width} maxRows={Math.max(1, Math.min(4, props.height - 8))}
      maxHeight={Math.max(4, props.height - 2 - footerLines.length - hintLines.length)} theme={theme}
      appearance={preset.composer}
      placeholder="Follow up in this topic" hint="Enter send · Esc cancel edit" onLayoutRows={setComposerRows} streaming disabled={props.active === false}
      onSubmit={({ rawText, attachments }) => {
        const accepted = props.onFollowup(selected, rawText, attachments);
        if (accepted) { setEditing(false); setOffset(undefined); }
        return accepted;
      }} /> : null}
    {hintLines.map((line) => <Text key={line} color={theme.muted} wrap="truncate">{line}</Text>)}
  </Box>;
}
