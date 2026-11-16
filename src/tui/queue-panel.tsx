import React from "react";
import { Box, Text, useInput, useStdin } from "ink";
import type { QueuedInput } from "../agent/input-queue";
import { queuedInputText, type SubmittedInput } from "./input-routing";
import { PromptComposer, type FileAttachmentRef, type PromptSubmitPayload } from "./composer";
import { isMouseSequence, parseMouseWheel } from "./mouse";
import { useActiveTheme, type Theme } from "./theme";

export type QueueMessage = QueuedInput<SubmittedInput<FileAttachmentRef>>;
export interface QueueView {
  items: readonly QueueMessage[];
  editing?: QueueMessage;
  paused: boolean;
  canStopId?: string;
  stoppingId?: string;
  pauseReason?: string;
  pauseDetail?: string;
}
export interface QueuePanelProps extends QueueView {
  active?: boolean;
  width: number;
  height: number;
  theme?: Theme;
  onEdit: (id: string) => void;
  onSave: (payload: PromptSubmitPayload) => boolean;
  onDiscard: () => void;
  onCancel: (id: string) => void;
  onResume: () => void;
  onStop: (id: string) => void;
  onClose: () => void;
}

export function QueuePanel(props: QueuePanelProps): React.ReactElement {
  const theme = useActiveTheme(props.theme);
  const [selectedId, setSelectedId] = React.useState(props.items[0]?.id);
  const previousIndex = React.useRef(0);
  const foundIndex = props.items.findIndex((item) => item.id === selectedId);
  const selectedIndex = foundIndex >= 0 ? foundIndex : Math.max(0, Math.min(previousIndex.current, props.items.length - 1));
  React.useEffect(() => { previousIndex.current = selectedIndex; }, [selectedIndex]);
  const selected = props.items[selectedIndex];
  const [offset, setOffset] = React.useState(0);
  const visible = Math.max(1, Math.floor((props.height - 5) / 2));
  const maxOffset = Math.max(0, props.items.length - visible);
  const currentOffset = Math.max(0, Math.min(offset, selectedIndex, maxOffset));
  React.useEffect(() => {
    setOffset((value) => Math.max(0, Math.min(selectedIndex < value ? selectedIndex : selectedIndex >= value + visible ? selectedIndex - visible + 1 : value, maxOffset)));
  }, [selectedIndex, visible, maxOffset]);
  const move = React.useCallback((delta: number) => {
    const index = Math.max(0, Math.min(props.items.length - 1, selectedIndex + delta));
    setSelectedId(props.items[index]?.id);
  }, [props.items, selectedIndex]);
  const { stdin } = useStdin();
  React.useEffect(() => {
    const listener = (data: Buffer | string) => { const delta = parseMouseWheel(String(data)); if (delta && !props.editing) move(-delta * 3); };
    if (props.active === false) return;
    stdin.on("data", listener);
    return () => { stdin.off("data", listener); };
  }, [stdin, move, props.editing, props.active]);
  useInput((input, key) => {
    if (isMouseSequence(input)) return;
    if (props.editing) {
      if (key.escape) props.onDiscard();
      else if (key.ctrl && input === "x") props.onCancel(props.editing.id);
      return;
    }
    if (key.escape) props.onClose();
    else if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-visible);
    else if (key.pageDown) move(visible);
    else if ((input === "e" || key.return) && selected?.status === "pending") props.onEdit(selected.id);
    else if (input === "x" && selected && ["pending", "editing"].includes(selected.status)) props.onCancel(selected.id);
    else if (input === "r" && props.paused) props.onResume();
    else if (input === "k" && selected && selected.id === props.canStopId) props.onStop(selected.id);
  }, { isActive: props.active !== false });
  const pending = props.items.filter((item) => item.status === "pending" || item.status === "editing").length;
  const actions = selected?.status === "pending" ? "e edit · x cancel · Esc close"
    : selected?.status === "editing" ? "x cancel message · Esc close"
    : selected?.id === props.canStopId ? "k stop active turn · Esc close" : "Esc close";
  return <Box flexDirection="column" width={props.width} height={props.height} overflow="hidden">
    <Text color={theme.accent} bold wrap="truncate">Message queue · {pending}{props.paused ? " · paused" : ""}</Text>
    <Text color={theme.muted} wrap="truncate">{props.editing ? "Editing holds this message in its place." : props.paused && props.pauseDetail ? props.pauseDetail.replace(/\s+/g, " ") : props.paused
      ? props.stoppingId ? "Stopping the active request…" : props.pauseReason === "failed" ? "Failed · messages kept · r resumes" : props.pauseReason === "cancelled" ? "Stopped by user. r resumes." : "Queue paused. Press r to resume."
      : "Uses current mode/model when processing."}</Text>
    {props.editing ? <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
      <Text color={theme.text} wrap="truncate">{props.editing.input.attachments?.length ?? 0} attachment(s) · original position kept</Text>
      <PromptComposer key={props.editing.id} initialText={queuedInputText(props.editing.input)} initialAttachments={props.editing.input.attachments}
        width={props.width} maxRows={Math.max(1, props.height - 9)} maxHeight={Math.max(4, props.height - 4)} theme={theme} hint="Enter save · Esc discard edit" streaming disabled={props.active === false} onSubmit={props.onSave} />
      <Text color={theme.muted}>Ctrl+X cancel message</Text>
    </Box> : <>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {!props.items.length ? <Text color={theme.text}>No queued messages.</Text> : null}
        {props.items.slice(currentOffset, currentOffset + visible).map((item, index) => <Box key={item.id} flexDirection="column">
          <Text color={item.id === selected?.id ? theme.accent : theme.text} bold={item.id === selected?.id} wrap="truncate">
            {item.id === selected?.id ? "❯" : " "} {currentOffset + index + 1}. {queuedInputText(item.input).replace(/\s+/g, " ")}
          </Text>
          <Text color={theme.muted} wrap="truncate">  {item.id === props.stoppingId ? "stopping" : item.status === "running" ? "processing" : item.status} · {item.input.attachments?.length ?? 0} attachment(s)</Text>
        </Box>)}
      </Box>
      <Text color={theme.muted} wrap="truncate">{props.paused ? "↑/↓ · PgUp/PgDn · r resume queue" : "↑/↓ select · Wheel/PgUp/PgDn scroll"}</Text>
      <Text color={theme.muted} wrap="truncate">{actions}</Text>
    </>}
  </Box>;
}
