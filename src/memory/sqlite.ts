import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

import type { AgentMode, Message, Role, Usage } from "../types/schema";

export interface SessionRecord {
  id: string;
  title: string;
  mode: AgentMode;
  createdAt: number;
  updatedAt: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface HindsightNoteRecord {
  id: string;
  topic: string;
  insight: string;
  filePatterns: string[];
  updatedAt: number;
}

export interface MessageSearchHit {
  sessionId: string;
  messageId: string;
  role: Role;
  snippet: string;
  createdAt: number;
}

interface SessionRow {
  id: string;
  title: string;
  mode: string;
  created_at: number;
  updated_at: number;
  total_tokens: number;
  total_cost_usd: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content_json: string;
  created_at: number;
}

interface NoteRow {
  id: string;
  topic: string;
  insight: string;
  file_patterns: string;
  updated_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, session_id UNINDEXED, role, content);
CREATE TABLE IF NOT EXISTS hindsight_notes (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL UNIQUE,
  insight TEXT NOT NULL,
  file_patterns TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
`;

export class MemoryDatabase {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  createSession(input: { id?: string; title: string; mode: AgentMode }): SessionRecord {
    const now = Date.now();
    const id = input.id ?? `sess-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .query("INSERT INTO sessions (id, title, mode, created_at, updated_at, total_tokens, total_cost_usd) VALUES (?, ?, ?, ?, ?, 0, 0)")
      .run(id, input.title, input.mode, now, now);
    return this.getSession(id) as SessionRecord;
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null;
    return row ? toSession(row) : undefined;
  }

  listSessions(limit = 50): SessionRecord[] {
    const rows = this.db
      .query("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  updateSession(id: string, patch: { title?: string; mode?: AgentMode }): SessionRecord {
    const current = this.getSession(id);
    if (!current) throw new Error(`unknown session "${id}"`);
    this.db
      .query("UPDATE sessions SET title = ?, mode = ?, updated_at = ? WHERE id = ?")
      .run(patch.title ?? current.title, patch.mode ?? current.mode, Date.now(), id);
    return this.getSession(id) as SessionRecord;
  }

  deleteSession(id: string): boolean {
    const session = this.getSession(id);
    if (!session) return false;
    this.db.query("DELETE FROM messages_fts WHERE session_id = ?").run(id);
    this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
    return true;
  }

  forkSession(sourceSessionId: string, upToMessageId?: string, newTitle?: string): SessionRecord {
    const source = this.getSession(sourceSessionId);
    if (!source) throw new Error(`source session "${sourceSessionId}" not found`);
    const allMessages = this.loadMessages(sourceSessionId);
    let slice = allMessages;
    if (upToMessageId) {
      const idx = allMessages.findIndex((m) => m.id === upToMessageId);
      if (idx !== -1) {
        slice = allMessages.slice(0, idx + 1);
      }
    }
    const forked = this.createSession({
      title: newTitle ?? `${source.title} (fork)`,
      mode: source.mode,
    });
    for (const msg of slice) {
      this.saveMessage(forked.id, {
        id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        role: msg.role,
        content: msg.content,
        created_at: msg.created_at,
      });
    }
    return forked;
  }

  saveMessage(sessionId: string, message: Message): void {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`unknown session "${sessionId}"`);
    const createdAt = message.created_at ?? Date.now();
    this.db
      .query("INSERT INTO messages (id, session_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(message.id, sessionId, message.role, JSON.stringify(message.content), createdAt);
    this.db
      .query("INSERT INTO messages_fts (message_id, session_id, role, content) VALUES (?, ?, ?, ?)")
      .run(message.id, sessionId, message.role, plainText(message.content));
    this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(createdAt, sessionId);
  }

  loadMessages(sessionId: string): Message[] {
    const rows = this.db
      .query("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(sessionId) as unknown as MessageRow[];
    return rows.map((row) => ({
      id: row.id,
      role: row.role as Role,
      content: JSON.parse(row.content_json) as Message["content"],
      created_at: row.created_at,
    }));
  }

  searchMessages(query: string, options: { sessionId?: string; limit?: number } = {}): MessageSearchHit[] {
    const match = toFtsQuery(query);
    if (match.length === 0) return [];
    const limit = options.limit ?? 20;
    const select =
      "SELECT messages_fts.message_id AS message_id, messages_fts.session_id AS session_id, messages_fts.role AS role, messages.created_at AS created_at, snippet(messages_fts, 3, '[', ']', '...', 12) AS snip FROM messages_fts JOIN messages ON messages.id = messages_fts.message_id WHERE messages_fts MATCH ?";
    const rows = options.sessionId
      ? (this.db
          .query(`${select} AND messages_fts.session_id = ? ORDER BY rank LIMIT ?`)
          .all(match, options.sessionId, limit) as unknown as Array<Record<string, unknown>>)
      : (this.db
          .query(`${select} ORDER BY rank LIMIT ?`)
          .all(match, limit) as unknown as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      messageId: String(row.message_id),
      role: String(row.role) as Role,
      snippet: String(row.snip ?? ""),
      createdAt: Number(row.created_at ?? 0),
    }));
  }

  recordUsage(sessionId: string, usage: Usage): void {
    const tokens = usage.prompt_tokens + usage.completion_tokens;
    const result = this.db
      .query("UPDATE sessions SET total_tokens = total_tokens + ?, total_cost_usd = total_cost_usd + ?, updated_at = ? WHERE id = ?")
      .run(tokens, usage.cost_usd ?? 0, Date.now(), sessionId);
    if (result.changes === 0) throw new Error(`unknown session "${sessionId}"`);
  }

  saveInsight(input: { topic: string; insight: string; filePatterns?: string[] }): HindsightNoteRecord {
    const now = Date.now();
    const patterns = JSON.stringify(input.filePatterns ?? []);
    const existing = this.db.query("SELECT id FROM hindsight_notes WHERE topic = ?").get(input.topic) as
      | { id: string }
      | null;
    if (existing) {
      this.db
        .query("UPDATE hindsight_notes SET insight = ?, file_patterns = ?, updated_at = ? WHERE id = ?")
        .run(input.insight, patterns, now, existing.id);
      return this.getInsight(existing.id) as HindsightNoteRecord;
    }
    const id = `note-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .query("INSERT INTO hindsight_notes (id, topic, insight, file_patterns, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.topic, input.insight, patterns, now);
    return this.getInsight(id) as HindsightNoteRecord;
  }

  getInsight(id: string): HindsightNoteRecord | undefined {
    const row = this.db.query("SELECT * FROM hindsight_notes WHERE id = ?").get(id) as NoteRow | null;
    return row ? toNote(row) : undefined;
  }

  listInsights(limit = 50): HindsightNoteRecord[] {
    const rows = this.db
      .query("SELECT * FROM hindsight_notes ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as unknown as NoteRow[];
    return rows.map(toNote);
  }

  searchInsights(query: string, limit = 20): HindsightNoteRecord[] {
    const needle = `%${query.toLowerCase()}%`;
    const rows = this.db
      .query(
        "SELECT * FROM hindsight_notes WHERE lower(topic) LIKE ? OR lower(insight) LIKE ? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(needle, needle, limit) as unknown as NoteRow[];
    return rows.map(toNote);
  }

  close(): void {
    this.db.close();
  }
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode as AgentMode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    totalTokens: row.total_tokens,
    totalCostUsd: row.total_cost_usd,
  };
}

function toNote(row: NoteRow): HindsightNoteRecord {
  let filePatterns: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.file_patterns);
    if (Array.isArray(parsed)) filePatterns = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    filePatterns = [];
  }
  return {
    id: row.id,
    topic: row.topic,
    insight: row.insight,
    filePatterns,
    updatedAt: row.updated_at,
  };
}

function plainText(content: Message["content"]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" || block.type === "thinking") parts.push(block.type === "text" ? block.text : block.thinking);
    else if (block.type === "tool_use") parts.push(`${block.name} ${JSON.stringify(block.input)}`);
    else if (block.type === "tool_result") {
      parts.push(typeof block.content === "string" ? block.content : block.content.map((item) => item.text).join("\n"));
    }
  }
  return parts.join("\n");
}

function toFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" ");
}
