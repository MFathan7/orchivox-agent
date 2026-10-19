import React from "react";
import { Box, Text, useInput } from "ink";

import type { MemoryDatabase, MessageSearchHit, SessionRecord } from "../memory/sqlite";
import type { RestoreResult, SnapshotEntry, SnapshotHistory, SnapshotManager } from "../vcs/snapshot";
import type { Message } from "../types/schema";
import { truncateText } from "./format";
import { deleteSessionFromList } from "./session-actions";
import { getTheme, type Theme } from "./theme";
import { useTerminalSize } from "./viewport";

export type SessionModalTab = "sessions" | "fork" | "timeline";

export interface SessionTimeTravelModalProps {
  database: MemoryDatabase;
  snapshots: SnapshotManager;
  activeSessionId?: string;
  activeSessionMessages?: Message[];
  initialTab?: SessionModalTab;
  onResumeSession?: (sessionId: string) => void;
  onForkSession?: (forkedSession: SessionRecord) => void;
  onNewSession?: () => void;
  onSessionDeleted?: (sessionId: string) => void;
  onRestoreSnapshot?: (result: RestoreResult) => void;
  onClose: () => void;
  theme?: Theme;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month} ${hours}:${minutes}`;
}

function getMessageText(message: Message): string {
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return `[thinking] ${block.thinking.slice(0, 40)}...`;
      if (block.type === "tool_use") return `[tool] ${block.name}`;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

export function SessionTimeTravelModal(props: SessionTimeTravelModalProps) {
  const {
    database,
    snapshots,
    activeSessionId,
    activeSessionMessages = [],
    initialTab = "sessions",
    onResumeSession,
    onForkSession,
    onNewSession,
    onSessionDeleted,
    onRestoreSnapshot,
    onClose,
    theme = getTheme("tokyonight"),
  } = props;

  const [activeTab, setActiveTab] = React.useState<SessionModalTab>(initialTab);

  // Tab 1 state
  const [sessions, setSessions] = React.useState<SessionRecord[]>([]);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchHits, setSearchHits] = React.useState<MessageSearchHit[]>([]);
  const [sessionIndex, setSessionIndex] = React.useState(0);
  const [statusNotice, setStatusNotice] = React.useState<string | undefined>();
  const { columns } = useTerminalSize();

  // Tab 2 state
  const [turnIndex, setTurnIndex] = React.useState(0);

  // Tab 3 state
  const [snapshotHistory, setSnapshotHistory] = React.useState<SnapshotHistory>({ entries: [], cursor: -1 });
  const [snapshotIndex, setSnapshotIndex] = React.useState(0);
  const [changedFiles, setChangedFiles] = React.useState<string[]>([]);

  const refreshSessions = React.useCallback(() => {
    try {
      const all = database.listSessions(100);
      setSessions(all);
    } catch {
      setSessions([]);
    }
  }, [database]);

  React.useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  React.useEffect(() => {
    if (activeTab === "sessions") {
      if (searchQuery.trim().length > 0) {
        try {
          const hits = database.searchMessages(searchQuery.trim(), { limit: 20 });
          setSearchHits(hits);
        } catch {
          setSearchHits([]);
        }
      } else {
        setSearchHits([]);
      }
      setSessionIndex(0);
    }
  }, [database, searchQuery, activeTab]);

  React.useEffect(() => {
    if (activeTab === "timeline") {
      void snapshots.getHistory().then((history) => {
        setSnapshotHistory(history);
        setSnapshotIndex(Math.max(0, history.cursor));
      });
    }
  }, [snapshots, activeTab]);

  React.useEffect(() => {
    if (activeTab === "timeline" && snapshotHistory.entries.length > 0) {
      const snap = snapshotHistory.entries[snapshotIndex];
      if (snap) {
        void snapshots.getChangedFiles(snap.id).then((files) => {
          setChangedFiles(files);
        });
      } else {
        setChangedFiles([]);
      }
    }
  }, [snapshots, snapshotHistory, snapshotIndex, activeTab]);

  const activeMessages = React.useMemo(() => {
    if (activeSessionId) {
      try {
        const dbMsgs = database.loadMessages(activeSessionId);
        if (dbMsgs.length > 0) return dbMsgs;
      } catch {
        // Fall back to props if loading fails.
      }
    }
    return activeSessionMessages;
  }, [database, activeSessionId, activeSessionMessages]);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.ctrl && input === "n") {
      onNewSession?.();
      onClose();
      return;
    }

    if (input === "1" && activeTab !== "sessions" && searchQuery.length === 0) {
      setActiveTab("sessions");
      return;
    }
    if (input === "2" && activeTab !== "fork" && searchQuery.length === 0) {
      setActiveTab("fork");
      return;
    }
    if (input === "3" && activeTab !== "timeline" && searchQuery.length === 0) {
      setActiveTab("timeline");
      return;
    }

    if (key.tab) {
      if (activeTab === "sessions") setActiveTab("fork");
      else if (activeTab === "fork") setActiveTab("timeline");
      else setActiveTab("sessions");
      return;
    }

    if (activeTab === "sessions") {
      const totalItems = searchHits.length > 0 ? searchHits.length : sessions.length;

      if (key.upArrow) {
        setSessionIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, totalItems - 1)));
        return;
      }
      if (key.downArrow) {
        setSessionIndex((prev) => (prev < totalItems - 1 ? prev + 1 : 0));
        return;
      }

      if (key.return) {
        let chosenSessionId: string | undefined;
        if (searchHits.length > 0) {
          chosenSessionId = searchHits[sessionIndex]?.sessionId;
        } else if (sessions.length > 0) {
          chosenSessionId = sessions[sessionIndex]?.id;
        }

        if (chosenSessionId) {
          onResumeSession?.(chosenSessionId);
          onClose();
        }
        return;
      }

      if ((input === "d" || input === "D" || key.delete) && searchQuery.length === 0) {
        const s = sessions[sessionIndex];
        if (s) {
          const result = deleteSessionFromList({
            database,
            session: s,
            activeSessionId,
            onSessionDeleted,
            onClose,
          });
          if (result.deleted && !result.closed) {
            setStatusNotice(`Session "${s.title}" deleted successfully.`);
            refreshSessions();
            setSessionIndex((prev) => Math.max(0, prev - 1));
          }
        }
        return;
      }

      const isBackspace = Boolean(key.backspace || key.delete || input === "\x7f" || input === "\b");

      if (isBackspace) {
        setSearchQuery((prev) => prev.slice(0, -1));
        return;
      }

      if (!key.ctrl && !key.meta && !isBackspace && input.length > 0 && input >= " " && input !== "\x7f") {
        setSearchQuery((prev) => prev + input);
      }
      return;
    }

    if (activeTab === "fork") {
      if (key.upArrow) {
        setTurnIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, activeMessages.length - 1)));
        return;
      }
      if (key.downArrow) {
        setTurnIndex((prev) => (prev < activeMessages.length - 1 ? prev + 1 : 0));
        return;
      }

      if (input === "f" || input === "F" || key.return) {
        const targetMessage = activeMessages[turnIndex];
        if (targetMessage && activeSessionId) {
          try {
            const forked = database.forkSession(activeSessionId, targetMessage.id);
            onForkSession?.(forked);
            onClose();
          } catch (error) {
            setStatusNotice(`Fork failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      return;
    }

    if (activeTab === "timeline") {
      const totalEntries = snapshotHistory.entries.length;
      if (key.upArrow) {
        setSnapshotIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, totalEntries - 1)));
        return;
      }
      if (key.downArrow) {
        setSnapshotIndex((prev) => (prev < totalEntries - 1 ? prev + 1 : 0));
        return;
      }

      if (key.return) {
        const selectedSnap = snapshotHistory.entries[snapshotIndex];
        if (selectedSnap) {
          void snapshots.restoreTo(selectedSnap.id).then((result) => {
            onRestoreSnapshot?.(result);
            onClose();
          });
        }
      }
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.active}
      paddingX={1}
      marginY={1}
    >
      <Box justifyContent="space-between" marginBottom={0}>
        <Box gap={2}>
          <Text
            bold={activeTab === "sessions"}
            color={activeTab === "sessions" ? theme.accent : theme.muted}
          >
            1. Sessions & FTS Search
          </Text>
          <Text
            bold={activeTab === "fork"}
            color={activeTab === "fork" ? theme.modes.build.primary : theme.muted}
          >
            2. Conversation Forking
          </Text>
          <Text
            bold={activeTab === "timeline"}
            color={activeTab === "timeline" ? theme.modes.ultrawork.primary : theme.muted}
          >
            3. Git Snapshot Timeline
          </Text>
        </Box>
        <Text dimColor>Esc Close  |  Tab Switch Tab  |  Ctrl+N New Session</Text>
      </Box>

      {statusNotice ? (
        <Box marginY={0}>
          <Text color={theme.modes.ultrawork.primary}>{statusNotice}</Text>
        </Box>
      ) : null}

      {activeTab === "sessions" ? (
        <Box flexDirection="column" marginY={1}>
          <Box borderStyle="single" borderColor={theme.border.passive} paddingX={1} marginY={0}>
            <Text color={theme.accent} bold>
              FTS5 Search:{" "}
            </Text>
            <Text>{searchQuery}</Text>
            <Text inverse color={theme.accent}> </Text>
            {searchQuery.length === 0 ? (
              <Text dimColor>Type keyword for instant FTS search across sessions...</Text>
            ) : null}
          </Box>

          <Box flexDirection="column" marginY={1}>
            <Text bold color={theme.modes.plan.primary}>
              {searchHits.length > 0
                ? `Search Results (${searchHits.length})`
                : `Session History (${sessions.length})`}
            </Text>
            {searchHits.length > 0 ? (
              searchHits.slice(0, 10).map((hit, idx) => {
                const isSelected = idx === sessionIndex;
                const label = `● ${hit.role.toUpperCase()}: ${hit.snippet}`;
                return (
                  <Text
                    key={`hit-${hit.messageId}-${idx}`}
                    color={isSelected ? theme.accent : theme.muted}
                    bold={isSelected}
                    wrap="truncate"
                  >
                    {isSelected ? "❯ " : "  "}
                    {truncateText(label, Math.max(24, columns - 12))}
                  </Text>
                );
              })
            ) : sessions.length === 0 ? (
              <Text dimColor>No conversation sessions found.</Text>
            ) : (
              sessions.slice(0, 10).map((sess, idx) => {
                const isSelected = idx === sessionIndex;
                const isCurrent = sess.id === activeSessionId;
                return (
                  <Box key={sess.id} justifyContent="space-between">
                    <Box>
                      <Text color={isSelected ? theme.accent : undefined} bold={isSelected} wrap="truncate">
                        {isSelected ? "❯ " : "  "}
                        {truncateText(sess.title, Math.max(16, columns - 34))}
                      </Text>
                      {isCurrent ? <Text color={theme.modes.build.primary}> (active)</Text> : null}
                    </Box>
                    <Text dimColor>{formatTimestamp(sess.updatedAt)}</Text>
                  </Box>
                );
              })
            )}
          </Box>

          <Box justifyContent="space-between">
            <Text dimColor>
              Enter Resume Session  |  d Delete Session  |  Up/Down Select Session
            </Text>
          </Box>
        </Box>
      ) : null}

      {activeTab === "fork" ? (
        <Box flexDirection="column" marginY={1}>
          <Box justifyContent="space-between" marginBottom={1}>
            <Text bold color={theme.modes.build.primary}>
              Conversation Forking: Choose a Turn to Create a New Branch
            </Text>
            <Text dimColor>{activeMessages.length} turns</Text>
          </Box>

          {activeMessages.length === 0 ? (
            <Text dimColor>No message turns available to fork in this session.</Text>
          ) : (
            activeMessages.slice(0, 10).map((msg, idx) => {
              const isSelected = idx === turnIndex;
              const textContent = getMessageText(msg);

              return (
                <Box key={msg.id} marginY={0}>
                  <Text color={isSelected ? theme.modes.build.primary : undefined} bold={isSelected}>
                    {isSelected ? "❯ " : "  "}
                    Turn {idx + 1} {msg.role.toUpperCase()}:{" "}
                  </Text>
                  <Text dimColor={!isSelected}>
                    {textContent.length > 70 ? `${textContent.slice(0, 67)}...` : textContent}
                  </Text>
                </Box>
              );
            })
          )}

          <Box marginTop={1} justifyContent="space-between">
            <Text dimColor>
              f / Enter Fork New Session from Selected Turn  |  Up/Down Select Turn
            </Text>
          </Box>
        </Box>
      ) : null}

      {activeTab === "timeline" ? (
        <Box flexDirection="column" marginY={1}>
          <Box justifyContent="space-between" marginBottom={1}>
            <Text bold color={theme.modes.ultrawork.primary}>
              Shadow Git Snapshot Timeline
            </Text>
            <Text dimColor>
              {snapshotHistory.entries.length} snapshots stored
            </Text>
          </Box>

          <Box flexDirection="row">
            <Box flexDirection="column" width="55%" paddingRight={1}>
              {snapshotHistory.entries.length === 0 ? (
                <Text dimColor>No git snapshots recorded yet.</Text>
              ) : (
                snapshotHistory.entries.slice(0, 8).map((snap, idx) => {
                  const isSelected = idx === snapshotIndex;
                  const isCurrent = idx === snapshotHistory.cursor;

                  return (
                    <Box key={snap.id} justifyContent="space-between">
                      <Box>
                        <Text color={isSelected ? theme.modes.ultrawork.primary : undefined} bold={isSelected}>
                          {isSelected ? "❯ " : "  "}
                          {snap.label.slice(0, 30)}
                        </Text>
                        {isCurrent ? (
                          <Text color={theme.modes.build.primary} bold>
                            {" "}
                            ACTIVE
                          </Text>
                        ) : null}
                      </Box>
                      <Text dimColor>{formatTimestamp(snap.createdAt)}</Text>
                    </Box>
                  );
                })
              )}
            </Box>

            <Box flexDirection="column" width="45%" borderStyle="single" borderColor={theme.border.passive} paddingX={1}>
              <Text bold color={theme.accent}>
                Changed Files
              </Text>
              {changedFiles.length === 0 ? (
                <Text dimColor>(No modified files in this snapshot)</Text>
              ) : (
                changedFiles.map((file, idx) => (
                  <Text key={`file-${idx}`} color={theme.modes.build.primary}>
                    • {file}
                  </Text>
                ))
              )}
            </Box>
          </Box>

          <Box marginTop={1} justifyContent="space-between">
            <Text dimColor>
              Enter Restore Workspace to Snapshot  |  Up/Down Select Snapshot
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
