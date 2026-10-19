import { describe, expect, it } from "bun:test";

import { MemoryDatabase } from "../src/memory/sqlite";
import { deleteSessionFromList } from "../src/tui/session-actions";

describe("session deletion", () => {
  it("notifies the app and closes when the active session is deleted", () => {
    const database = new MemoryDatabase(":memory:");
    const session = database.createSession({ title: "active session", mode: "build" });
    let deletedId: string | undefined;
    let closed = false;

    const result = deleteSessionFromList({
      database,
      session,
      activeSessionId: session.id,
      onSessionDeleted: (id) => {
        deletedId = id;
      },
      onClose: () => {
        closed = true;
      },
    });

    expect(result).toEqual({ deleted: true, closed: true });
    expect(deletedId).toBe(session.id);
    expect(closed).toBe(true);
    expect(database.getSession(session.id)).toBeUndefined();
    database.close();
  });

  it("keeps the modal open when another session is deleted", () => {
    const database = new MemoryDatabase(":memory:");
    const active = database.createSession({ title: "active", mode: "build" });
    const other = database.createSession({ title: "other", mode: "build" });
    let notified = false;
    let closed = false;

    const result = deleteSessionFromList({
      database,
      session: other,
      activeSessionId: active.id,
      onSessionDeleted: () => {
        notified = true;
      },
      onClose: () => {
        closed = true;
      },
    });

    expect(result).toEqual({ deleted: true, closed: false });
    expect(notified).toBe(false);
    expect(closed).toBe(false);
    expect(database.getSession(other.id)).toBeUndefined();
    expect(database.getSession(active.id)).toBeDefined();
    database.close();
  });
});
