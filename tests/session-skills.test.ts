import { afterEach, describe, expect, it } from "bun:test";

import { MemoryDatabase } from "../src/memory/sqlite";

const databases: MemoryDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("session skills", () => {
  it("stores active skills per session and copies them on fork", () => {
    const database = new MemoryDatabase(":memory:");
    databases.push(database);
    const source = database.createSession({ id: "sess-source", title: "source", mode: "build" });
    database.activateSessionSkill(source.id, "pdf");
    database.activateSessionSkill(source.id, "archify");
    expect(database.listSessionSkills(source.id).map((skill) => skill.name).sort()).toEqual([
      "archify",
      "pdf",
    ]);

    const forked = database.forkSession(source.id, undefined, "fork");
    expect(database.listSessionSkills(forked.id).map((skill) => skill.name).sort()).toEqual([
      "archify",
      "pdf",
    ]);

    database.clearSessionSkills(source.id);
    expect(database.listSessionSkills(source.id)).toEqual([]);
    expect(database.listSessionSkills(forked.id)).toHaveLength(2);
  });

  it("removes session skills when the session is deleted", () => {
    const database = new MemoryDatabase(":memory:");
    databases.push(database);
    const session = database.createSession({ id: "sess-delete", title: "delete", mode: "build" });
    database.activateSessionSkill(session.id, "pdf");
    database.deleteSession(session.id);
    expect(database.listSessionSkills(session.id)).toEqual([]);
  });
});
