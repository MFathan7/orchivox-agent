import { describe, expect, it } from "bun:test";

import { GranularPermissionEngine, isPlanReadOnlyShellCommand } from "../src/agent/permissions";

describe("plan mode read-only shell", () => {
  it("allows safe inspection commands", () => {
    expect(isPlanReadOnlyShellCommand("date")).toBe(true);
    expect(isPlanReadOnlyShellCommand("date +%H:%M")).toBe(true);
    expect(isPlanReadOnlyShellCommand("pwd")).toBe(true);
    expect(isPlanReadOnlyShellCommand("ls -la")).toBe(true);
    expect(isPlanReadOnlyShellCommand("git status --short")).toBe(true);
    expect(isPlanReadOnlyShellCommand("git log --oneline -5")).toBe(true);
    expect(isPlanReadOnlyShellCommand("find . -name '*.ts'")).toBe(true);
  });

  it("rejects writes, shell operators, and destructive commands", () => {
    expect(isPlanReadOnlyShellCommand("rm -rf /")).toBe(false);
    expect(isPlanReadOnlyShellCommand("echo hi > file")).toBe(false);
    expect(isPlanReadOnlyShellCommand("cat file | rm")).toBe(false);
    expect(isPlanReadOnlyShellCommand("git push")).toBe(false);
    expect(isPlanReadOnlyShellCommand("git reset --hard")).toBe(false);
    expect(isPlanReadOnlyShellCommand("find . -delete")).toBe(false);
    expect(isPlanReadOnlyShellCommand("find . -exec rm {} \\;")).toBe(false);
    expect(isPlanReadOnlyShellCommand("date -s 2020-01-01")).toBe(false);
    expect(isPlanReadOnlyShellCommand("hostname evil")).toBe(false);
  });

  it("allows bash date in plan mode but blocks writes", async () => {
    const engine = new GranularPermissionEngine({ repoRoot: process.cwd() });
    const bash = { name: "bash", readOnly: false };
    expect((await engine.check(bash, "plan", { command: "date" })).allowed).toBe(true);
    expect((await engine.check(bash, "plan", { command: "rm -rf /" })).allowed).toBe(false);
    expect((await engine.check({ name: "hash_edit", readOnly: false }, "plan")).allowed).toBe(false);
  });
});
