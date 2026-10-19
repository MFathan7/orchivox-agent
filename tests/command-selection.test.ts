import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fetchSlashCommands, requiresCommandArguments } from "../src/tui/autocomplete";

describe("command selection", () => {
  it("marks which built-in commands need arguments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orchivox-command-"));
    try {
      const items = await fetchSlashCommands(dir);
      const byLabel = new Map(items.map((item) => [item.label, item]));
      expect(byLabel.get("/help")?.requiresArgs).toBe(false);
      expect(byLabel.get("/models")?.requiresArgs).toBe(false);
      expect(byLabel.get("/mode")?.requiresArgs).toBe(false);
      expect(byLabel.get("/reasoning")?.requiresArgs).toBe(false);
      expect(byLabel.get("/theme")?.requiresArgs).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects required positional arguments in custom command templates", () => {
    expect(requiresCommandArguments("Review $ARGUMENTS")).toBe(false);
    expect(requiresCommandArguments("Target: $1")).toBe(true);
    expect(requiresCommandArguments("Run the test suite and fix failures")).toBe(false);
  });
});
