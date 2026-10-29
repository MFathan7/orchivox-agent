import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

import { COMPACT_LABEL } from "../agent/compaction";
import type { AgentMode, Message, Role, Usage } from "../types/schema";
import type { TaskItem, TaskStore } from "../agent/task-board";

export interface SessionRecord {
  id: string;
  title: string;
  mode: AgentMode;
  createdAt: number;
  updatedAt: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface SessionCompaction {
  summary: string;
  tail_start_message_id?: string;
  before_tokens: number;
  after_tokens: number;
  created_at: number;
  removed_messages?: number;
  auto?: boolean;
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
  metadata_json: string | null;
  created_at: number;
}

interface NoteRow {
  id: string;
  topic: string;
  insight: string;
  file_patterns: string;
  updated_at: number;
}

interface TaskRow {
  id: string;
  title: string;
  task: string;
  agent: string | null;
  role_model: string | null;
  provider: string | null;
  model: string | null;
  mode: string | null;
  depends_on: string;
  write_isolation: number;
  state: string;
  worker_id: string | null;
  result: string | null;
  error: string | null;
  diff: string | null;
  files_changed: string;
  merged: number | null;
  merge_summary: string | null;
  created_at: number;
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
  total_cost_usd REAL NOT NULL DEFAULT 0,
  compaction_json TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, session_id UNINDEXED, role, content);
CREATE TABLE IF NOT EXISTS session_skills (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  activated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, skill_name)
);
CREATE INDEX IF NOT EXISTS idx_session_skills_session ON session_skills(session_id, activated_at);
CREATE TABLE IF NOT EXISTS hindsight_notes (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL UNIQUE,
  insight TEXT NOT NULL,
  file_patterns TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  task TEXT NOT NULL,
  agent TEXT,
  role_model TEXT,
  provider TEXT,
  model TEXT,
  mode TEXT,
  depends_on TEXT NOT NULL DEFAULT '[]',
  write_isolation INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  worker_id TEXT,
  result TEXT,
  error TEXT,
  diff TEXT,
  files_changed TEXT NOT NULL DEFAULT '[]',
  merged INTEGER,
  merge_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
`;

export class MemoryDatabase implements TaskStore {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    const taskColumns = this.db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!taskColumns.some((column) => column.name === "mode")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN mode TEXT;");
    }
    const sessionColumns = this.db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "compaction_json")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN compaction_json TEXT;");
    }
    const messageColumns = this.db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!messageColumns.some((column) => column.name === "metadata_json")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN metadata_json TEXT;");
    }
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

  saveCompaction(sessionId: string, compaction: SessionCompaction): void {
    const result = this.db
      .query("UPDATE sessions SET compaction_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(compaction), Date.now(), sessionId);
    if (result.changes === 0) throw new Error(`unknown session "${sessionId}"`);
  }

  getCompaction(sessionId: string): SessionCompaction | undefined {
    const row = this.db.query("SELECT compaction_json FROM sessions WHERE id = ?").get(sessionId) as
      | { compaction_json: string | null }
      | null;
    if (!row?.compaction_json) return undefined;
    try {
      const parsed = JSON.parse(row.compaction_json) as SessionCompaction;
      if (!parsed || typeof parsed.summary !== "string") return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  clearCompaction(sessionId: string): void {
    this.db
      .query("UPDATE sessions SET compaction_json = NULL, updated_at = ? WHERE id = ?")
      .run(Date.now(), sessionId);
  }

  activateSessionSkill(sessionId: string, skillName: string): void {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`unknown session "${sessionId}"`);
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO session_skills (session_id, skill_name, activated_at) VALUES (?, ?, ?) ON CONFLICT(session_id, skill_name) DO UPDATE SET activated_at = excluded.activated_at",
      )
      .run(sessionId, skillName, now);
    this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
  }

  listSessionSkills(sessionId: string): Array<{ name: string; activatedAt: number }> {
    const rows = this.db
      .query(
        "SELECT skill_name, activated_at FROM session_skills WHERE session_id = ? ORDER BY activated_at ASC, skill_name ASC",
      )
      .all(sessionId) as Array<{ skill_name: string; activated_at: number }>;
    return rows.map((row) => ({ name: row.skill_name, activatedAt: row.activated_at }));
  }

  clearSessionSkills(sessionId: string): void {
    this.db.query("DELETE FROM session_skills WHERE session_id = ?").run(sessionId);
  }

  addSessionUsage(id: string, tokens: number, costUsd: number): void {
    this.db
      .query(
        "UPDATE sessions SET total_tokens = total_tokens + ?, total_cost_usd = total_cost_usd + ?, updated_at = ? WHERE id = ?",
      )
      .run(tokens, costUsd, Date.now(), id);
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
    const allMessages = this.loadFullMessages(sourceSessionId);
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
    const idMap = new Map<string, string>();
    for (const msg of slice) {
      const newId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      idMap.set(msg.id, newId);
      this.saveMessage(forked.id, {
        id: newId,
        role: msg.role,
        content: msg.content,
        metadata: msg.metadata,
        created_at: msg.created_at,
      });
    }
    if (!upToMessageId) {
      const compaction = this.getCompaction(sourceSessionId);
      const mappedTail = compaction?.tail_start_message_id
        ? idMap.get(compaction.tail_start_message_id)
        : undefined;
      if (compaction && mappedTail) {
        this.saveCompaction(forked.id, {
          ...compaction,
          tail_start_message_id: mappedTail,
          created_at: Date.now(),
        });
      }
    }
    for (const skill of this.listSessionSkills(sourceSessionId)) {
      this.activateSessionSkill(forked.id, skill.name);
    }
    return forked;
  }

  saveMessage(sessionId: string, message: Message): void {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`unknown session "${sessionId}"`);
    const createdAt = message.created_at ?? Date.now();
    const content = stripInlineImages(message.content);
    const metadata = message.metadata ? JSON.stringify(message.metadata) : null;
    this.db
      .query("INSERT INTO messages (id, session_id, role, content_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(message.id, sessionId, message.role, JSON.stringify(content), metadata, createdAt);
    this.db
      .query("INSERT INTO messages_fts (message_id, session_id, role, content) VALUES (?, ?, ?, ?)")
      .run(message.id, sessionId, message.role, plainText(content));
    this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(createdAt, sessionId);
  }

  loadMessages(sessionId: string): Message[] {
    const rows = this.loadFullMessages(sessionId);
    const compaction = this.getCompaction(sessionId);
    if (!compaction) return rows;
    if (!compaction.tail_start_message_id) return [summaryMessage(compaction)];
    let index = rows.findIndex((message) => message.id === compaction.tail_start_message_id);
    if (index === -1) return [summaryMessage(compaction)];
    // Never start the tail on a tool result: its call must stay in the context.
    while (index > 0 && rows[index]?.role === "tool") index -= 1;
    return [summaryMessage(compaction), ...rows.slice(index)];
  }

  loadFullMessages(sessionId: string): Message[] {
    const rows = this.db
      .query("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(sessionId) as unknown as MessageRow[];
    return rows.map((row) => {
      let metadata: Message["metadata"];
      if (row.metadata_json) {
        try {
          const parsed: unknown = JSON.parse(row.metadata_json);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            metadata = parsed as Message["metadata"];
          }
        } catch {
          // Ignore malformed metadata.
        }
      }
      return {
        id: row.id,
        role: row.role as Role,
        content: JSON.parse(row.content_json) as Message["content"],
        metadata,
        created_at: row.created_at,
      };
    });
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

  loadTasks(): TaskItem[] {
    const rows = this.db
      .query("SELECT * FROM tasks ORDER BY created_at ASC, rowid ASC")
      .all() as unknown as TaskRow[];
    return rows.map(toTaskItem);
  }

  saveTask(task: TaskItem): void {
    this.db
      .query(
        `INSERT INTO tasks (id, title, task, agent, role_model, provider, model, mode, depends_on, write_isolation, state, worker_id, result, error, diff, files_changed, merged, merge_summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           task = excluded.task,
           agent = excluded.agent,
           role_model = excluded.role_model,
           provider = excluded.provider,
           model = excluded.model,
           mode = excluded.mode,
           depends_on = excluded.depends_on,
           write_isolation = excluded.write_isolation,
           state = excluded.state,
           worker_id = excluded.worker_id,
           result = excluded.result,
           error = excluded.error,
           diff = excluded.diff,
           files_changed = excluded.files_changed,
           merged = excluded.merged,
           merge_summary = excluded.merge_summary,
           updated_at = excluded.updated_at`,
      )
      .run(
        task.id,
        task.title,
        task.task,
        task.agent ?? null,
        task.roleModel ?? null,
        task.provider ?? null,
        task.model ?? null,
        task.mode ?? null,
        JSON.stringify(task.dependsOn),
        task.writeIsolation ? 1 : 0,
        task.state,
        task.workerId ?? null,
        task.result ?? null,
        task.error ?? null,
        task.diff ?? null,
        JSON.stringify(task.filesChanged),
        task.merged === undefined ? null : task.merged ? 1 : 0,
        task.mergeSummary ?? null,
        task.createdAt,
        task.updatedAt,
      );
  }

  deleteTask(id: string): void {
    this.db.query("DELETE FROM tasks WHERE id = ?").run(id);
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

function summaryMessage(compaction: SessionCompaction): Message {
  return {
    id: `compaction-${compaction.created_at.toString(36)}`,
    role: "system",
    content: [{ type: "text", text: `${COMPACT_LABEL}\n${compaction.summary}` }],
    created_at: compaction.created_at,
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

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toTaskItem(row: TaskRow): TaskItem {
  return {
    id: row.id,
    title: row.title,
    task: row.task,
    agent: row.agent ?? undefined,
    roleModel: (row.role_model ?? undefined) as TaskItem["roleModel"],
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    mode: (row.mode ?? undefined) as TaskItem["mode"],
    dependsOn: parseStringArray(row.depends_on),
    writeIsolation: row.write_isolation === 1,
    state: row.state as TaskItem["state"],
    workerId: row.worker_id ?? undefined,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    diff: row.diff ?? undefined,
    filesChanged: parseStringArray(row.files_changed),
    merged: row.merged === null ? undefined : row.merged === 1,
    mergeSummary: row.merge_summary ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stripInlineImages(content: Message["content"]): Message["content"] {
  if (!content.some((block) => block.type === "image")) return content;
  return content.map((block) =>
    block.type === "image"
      ? { type: "text" as const, text: `[image: ${block.path ?? block.source.media_type}]` }
      : block,
  );
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
