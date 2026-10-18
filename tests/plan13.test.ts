import { describe, expect, it } from "bun:test";
import {
  scoreFuzzyMatch,
  detectTriggerContext,
  filterFuzzy,
  fetchSlashCommands,
  fetchProjectFiles,
  type AutocompleteItem,
} from "../src/tui/autocomplete";
import {
  parseFileAttachments,
  resolveFileAttachments,
  buildInjectedContext,
  getLineAndColumn,
  getCursorOffset,
  PersistentCommandHistory,
} from "../src/tui/composer";

describe("Autocomplete Engine", () => {
  it("computes accurate fuzzy match scores", () => {
    const exact = scoreFuzzyMatch("server", "server");
    const prefix = scoreFuzzyMatch("serv", "server");
    const mid = scoreFuzzyMatch("orch", "AgentOrchestrator");
    const none = scoreFuzzyMatch("xyz", "server");

    expect(exact).not.toBeNull();
    expect(prefix).not.toBeNull();
    expect(mid).not.toBeNull();
    expect(none).toBeNull();

    expect(exact!.score).toBeGreaterThan(prefix!.score);
    expect(prefix!.score).toBeGreaterThan(mid!.score);
  });

  it("filters and ranks fuzzy items", () => {
    const items = [
      { id: "1", name: "src/tui/app.tsx" },
      { id: "2", name: "src/tui/autocomplete.tsx" },
      { id: "3", name: "src/tools/shell.ts" },
    ];
    const results = filterFuzzy("auto", items, (item) => item.name);
    expect(results.length).toBe(1);
    expect(results[0].item.name).toBe("src/tui/autocomplete.tsx");
  });

  it("detects slash command triggers at the start of line", () => {
    const ctx = detectTriggerContext("/undo", 5);
    expect(ctx).not.toBeNull();
    expect(ctx!.trigger).toBe("command");
    expect(ctx!.query).toBe("undo");
    expect(ctx!.replaceStart).toBe(0);
    expect(ctx!.replaceEnd).toBe(5);
  });

  it("detects @file trigger in sentence and supports line ranges", () => {
    const text = "check file @src/api/server.ts:10-45";
    const ctx = detectTriggerContext(text, text.length);
    expect(ctx).not.toBeNull();
    expect(ctx!.trigger).toBe("file");
    expect(ctx!.query).toBe("src/api/server.ts:10-45");
  });

  it("detects #symbol trigger in sentence", () => {
    const text = "explain #AgentOrchestrator";
    const ctx = detectTriggerContext(text, text.length);
    expect(ctx).not.toBeNull();
    expect(ctx!.trigger).toBe("symbol");
    expect(ctx!.query).toBe("AgentOrchestrator");
  });

  it("loads builtin slash commands", async () => {
    const commands = await fetchSlashCommands();
    expect(commands.some((c) => c.label === "/commit")).toBe(true);
    expect(commands.some((c) => c.label === "/undo")).toBe(true);
    expect(commands.some((c) => c.label === "/compact")).toBe(true);
  });

  it("scans workspace files excluding node_modules and .git", async () => {
    const files = await fetchProjectFiles();
    expect(files.some((f) => f.label.includes("package.json"))).toBe(true);
    expect(files.some((f) => f.label.startsWith(".git/"))).toBe(false);
    expect(files.some((f) => f.label.startsWith("node_modules/"))).toBe(false);
  });
});

describe("Composer Engine", () => {
  it("parses file references and line ranges", () => {
    const text = "Please inspect @src/index.ts and @src/api/server.ts:12-40";
    const attachments = parseFileAttachments(text);
    expect(attachments.length).toBe(2);

    expect(attachments[0].filePath).toBe("src/index.ts");
    expect(attachments[0].startLine).toBeUndefined();

    expect(attachments[1].filePath).toBe("src/api/server.ts");
    expect(attachments[1].startLine).toBe(12);
    expect(attachments[1].endLine).toBe(40);
  });

  it("resolves file attachments and estimates tokens", async () => {
    const parsed = parseFileAttachments("Check @PLAN13.md:1-5");
    const resolved = await resolveFileAttachments(parsed);

    expect(resolved.length).toBe(1);
    expect(resolved[0].exists).toBe(true);
    expect(resolved[0].tokens).toBeGreaterThan(0);
  });

  it("builds injected context with hashline format line_number:hash| content", async () => {
    const parsed = parseFileAttachments("Inspect @PLAN13.md:1-3");
    const resolved = await resolveFileAttachments(parsed);
    const injected = await buildInjectedContext(resolved);

    expect(injected).toContain("File Context: PLAN13.md:1-3");
    expect(injected).toMatch(/1:[0-9a-f]{3}\|/);
    expect(injected).toMatch(/2:[0-9a-f]{3}\|/);
    expect(injected).toMatch(/3:[0-9a-f]{3}\|/);
  });

  it("computes line and column offsets for multi-line editing", () => {
    const multiline = "line1\nsecond line\n3";
    // Cursor at 's' in 'second line' (index 6)
    const pos = getLineAndColumn(multiline, 6);
    expect(pos.line).toBe(1);
    expect(pos.col).toBe(0);

    const backToOffset = getCursorOffset(pos.lines, 1, 0);
    expect(backToOffset).toBe(6);
  });

  it("manages persistent command history and draft restoration", async () => {
    const tmpHistoryFile = `/tmp/test-orchivox-history-${Date.now()}.json`;
    const history = new PersistentCommandHistory(tmpHistoryFile);

    await history.append("cmd 1");
    await history.append("cmd 2");

    const prev1 = history.getPrevious("my current draft");
    expect(prev1).toBe("cmd 2");

    const prev2 = history.getPrevious("my current draft");
    expect(prev2).toBe("cmd 1");

    const next1 = history.getNext();
    expect(next1?.text).toBe("cmd 2");

    const next2 = history.getNext();
    expect(next2?.text).toBe("my current draft");
    expect(next2?.isDraft).toBe(true);
  });
});
