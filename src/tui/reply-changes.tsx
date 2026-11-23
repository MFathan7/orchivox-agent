import React from "react";
import { Box, Text, useInput } from "ink";

import { ReplyChangesConflict, replyFileDiff, type ReplyFileChange, type SavedReplyChanges } from "../vcs/reply-changes";
import type { ChatEntryView } from "./app";
import { diffRows } from "./diff-view";
import { formatReplyDate } from "./format";
import { isMouseSequence } from "./mouse";
import { fitDisplayText, singleLine, wrapText } from "./text-wrap";
import type { Theme } from "./theme";

interface ReplyChangesModalProps {
  entries: ChatEntryView[];
  width: number;
  height: number;
  theme: Theme;
  load: (id: string) => SavedReplyChanges | undefined;
  undo: (id: string) => void;
  onClose: () => void;
}

function fileLabel(file: ReplyFileChange): string {
  if (file.issue) return "Unverified";
  if (file.before === null) return "Added";
  if (file.after === null) return "Deleted";
  return "Modified";
}

export function ReplyChangesModal({ entries, width, height, theme, load, undo, onClose }: ReplyChangesModalProps) {
  const [replyIndex, setReplyIndex] = React.useState(0);
  const [fileIndex, setFileIndex] = React.useState(0);
  const [diffOffset, setDiffOffset] = React.useState<number | undefined>();
  const [confirm, setConfirm] = React.useState(false);
  const [notice, setNotice] = React.useState<string>();
  const [conflicts, setConflicts] = React.useState<string[]>([]);
  const entry = entries[Math.min(replyIndex, entries.length - 1)];
  const loadRef = React.useRef(load);
  loadRef.current = load;
  const review = React.useMemo(() => {
    if (!entry?.replyChangeId) return {};
    try { return { saved: loadRef.current(entry.replyChangeId) }; }
    catch (error) { return { error: (error as Error).message }; }
  }, [entry?.replyChangeId, entry?.replyChangesReverted]);
  const files = review.saved?.files ?? [];
  const file = files[fileIndex];
  const reverted = review.saved?.reverted || entry?.replyChangesReverted;
  const unavailable = files.find(({ issue, before, after }) => issue || before === undefined || after === undefined);
  const canUndo = Boolean(entry && files.length && !reverted && !unavailable);
  const preview = React.useMemo(() => {
    if (!file || diffOffset === undefined) return {};
    const texts = replyFileDiff(file);
    if (!texts) return { message: file.issue ?? "Text diff unavailable for this file." };
    if (texts.before.length + texts.after.length > 100_000) return { message: "This file is too large for a terminal diff." };
    const rows = diffRows(texts.before, texts.after, "Before", "After", width, theme, true, undefined, { showFileHeader: false });
    return rows.length ? { rows } : { message: "No text differences." };
  }, [file, diffOffset === undefined, width, theme]);
  const error = notice ?? review.error;
  const status = reverted ? "Changes reverted" : error ? singleLine(error) : unavailable
    ? `Undo unavailable. ${singleLine(unavailable.issue ?? unavailable.path)}`
    : entry && !review.saved ? "Saved changes are unavailable." : undefined;
  const statusLines = status ? wrapText(status, width).slice(0, 3) : [];
  const bodyRows = Math.max(1, height - 4 - statusLines.length);
  const fileStart = Math.max(0, fileIndex - bodyRows + 1);
  const maxDiffOffset = Math.max(0, (preview.rows?.length ?? 0) - bodyRows);
  const switchReply = (next: number) => {
    setReplyIndex(Math.max(0, Math.min(entries.length - 1, next)));
    setFileIndex(0);
    setNotice(undefined);
    setConflicts([]);
  };

  useInput((input, key) => {
    if (isMouseSequence(input)) return;
    if (confirm) {
      if (key.escape) setConfirm(false);
      if (key.return && entry?.replyChangeId && canUndo) {
        setConfirm(false);
        try {
          undo(entry.replyChangeId);
          setNotice(undefined);
          setConflicts([]);
        } catch (error) {
          setNotice((error as Error).message);
          setConflicts(error instanceof ReplyChangesConflict ? error.paths : []);
        }
      }
      return;
    }
    if (diffOffset !== undefined) {
      if (key.escape) setDiffOffset(undefined);
      if (key.upArrow || key.pageUp) setDiffOffset(Math.max(0, Math.min(maxDiffOffset, diffOffset) - (key.pageUp ? bodyRows : 1)));
      if (key.downArrow || key.pageDown) setDiffOffset(Math.min(maxDiffOffset, diffOffset + (key.pageDown ? bodyRows : 1)));
      return;
    }
    if (key.escape) { onClose(); return; }
    if (key.leftArrow) switchReply(replyIndex + 1);
    if (key.rightArrow) switchReply(replyIndex - 1);
    if (key.upArrow) setFileIndex(Math.max(0, fileIndex - 1));
    if (key.downArrow && fileIndex + 1 < files.length) setFileIndex(fileIndex + 1);
    if (key.return && file) setDiffOffset(0);
    if (input === "u" && !key.ctrl && canUndo) { setNotice(undefined); setConfirm(true); }
  });

  return (
    <Box flexDirection="column" width={width}>
      <Text bold color={theme.text} wrap="truncate">Review changes</Text>
      {entry ? <Text color={theme.muted} wrap="truncate">
        {fitDisplayText(`Reply ${entries.length - replyIndex}/${entries.length}${entries.length > 1 ? " (←/→)" : ""} · ${entry.replyChangeCount} files${entry.completedAt ? ` · ${formatReplyDate(entry.completedAt)}` : ""}`, width)}
      </Text> : null}
      {confirm ? (
        <>
          <Text color={theme.text} wrap="truncate">{fitDisplayText(`Undo changes to ${files.length} file${files.length === 1 ? "" : "s"}?`, width)}</Text>
          <Text color={theme.muted} wrap="truncate">{fitDisplayText("Enter undo · Esc back", width)}</Text>
        </>
      ) : diffOffset !== undefined && file ? (
        <>
          <Text bold color={theme.text} wrap="truncate">{fitDisplayText(singleLine(file.path), width)}</Text>
          {preview.rows?.slice(Math.min(diffOffset, maxDiffOffset), Math.min(diffOffset, maxDiffOffset) + bodyRows).map((row) => <React.Fragment key={row.key}>{row.node}</React.Fragment>)}
          {preview.message ? <Text color={theme.muted} wrap="truncate">{fitDisplayText(preview.message, width)}</Text> : null}
          <Text color={theme.muted} wrap="truncate">{fitDisplayText("↑/↓ scroll · Esc files", width)}</Text>
        </>
      ) : (
        <>
          {files.slice(fileStart, fileStart + bodyRows).map((item, index) => {
            const selected = fileStart + index === fileIndex;
            const conflict = conflicts.includes(item.path);
            return <Text key={item.path} color={conflict ? theme.status.error : selected ? theme.text : theme.muted} bold={selected} wrap="truncate">
              {fitDisplayText(`${selected ? "›" : " "} ${conflict ? "Conflict" : fileLabel(item)}  ${singleLine(item.path)}`, width)}
            </Text>;
          })}
          {!entry ? <Text color={theme.muted} wrap="truncate">No reply changes to review.</Text> : null}
          {statusLines.map((line, index) => <Text key={index} color={error ? theme.status.error : theme.muted} wrap="truncate">{line}</Text>)}
          <Text color={theme.muted} wrap="truncate">
            {fitDisplayText(`${files.length ? "Enter diff · " : ""}${canUndo ? "U undo · " : ""}Esc close`, width)}
          </Text>
        </>
      )}
    </Box>
  );
}
