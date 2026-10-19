import type { MemoryDatabase, SessionRecord } from "../memory/sqlite";

export interface DeleteSessionResult {
  deleted: boolean;
  closed: boolean;
}

export function deleteSessionFromList(options: {
  database: MemoryDatabase;
  session: SessionRecord | undefined;
  activeSessionId?: string;
  onSessionDeleted?: (sessionId: string) => void;
  onClose: () => void;
}): DeleteSessionResult {
  const { database, session, activeSessionId, onSessionDeleted, onClose } = options;
  if (!session) return { deleted: false, closed: false };
  const wasActive = session.id === activeSessionId;
  const deleted = database.deleteSession(session.id);
  if (deleted && wasActive) {
    onSessionDeleted?.(session.id);
    onClose();
    return { deleted: true, closed: true };
  }
  return { deleted, closed: false };
}
