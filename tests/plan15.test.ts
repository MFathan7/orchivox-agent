import { describe, expect, it } from "bun:test";
import { ProviderRouter } from "../src/provider/router";
import { MemoryDatabase } from "../src/memory/sqlite";
import { SnapshotManager } from "../src/vcs/snapshot";
import { REASONING_LEVELS } from "../src/tui/command-palette";
import type { AppConfig } from "../config/loader";

const MOCK_CONFIG: AppConfig = {
  version: 1,
  providers: {
    openai: {
      kind: "openai",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-test",
      models: ["gpt-4o", "gpt-4o-mini"],
      headers: {},
      timeout_ms: 30000,
      enabled: true,
    },
    anthropic: {
      kind: "anthropic",
      base_url: "https://api.anthropic.com",
      api_key: "sk-ant-test",
      models: ["claude-3-7-sonnet", "claude-3-5-haiku"],
      headers: {},
      timeout_ms: 30000,
      enabled: true,
    },
  },
  roles: {
    main_model: { provider: "anthropic", model: "claude-3-7-sonnet" },
    fast_model: { provider: "openai", model: "gpt-4o-mini" },
    advisor_model: { provider: "anthropic", model: "claude-3-5-haiku" },
  },
  inbound_server: { port: 8787, enable_openapi: true, enable_openclaude: false },
  lsp: { servers: {} },
  mcp: { servers: {} },
  sandbox: {
    permissions: {
      filesystem: { read: ["**/*"], write: [], deny: [".git/**"] },
      network: { allow: [], deny: [] },
      commands: { allow: [], deny: [], escalate: "ask" },
    },
  },
};

describe("ProviderRouter Model Switcher", () => {
  it("lists all configured models across active providers", () => {
    const router = new ProviderRouter(MOCK_CONFIG);
    const models = router.listAllConfiguredModels();

    expect(models.length).toBe(4);
    expect(models.some((m) => m.provider === "openai" && m.model === "gpt-4o")).toBe(true);
    expect(models.some((m) => m.provider === "anthropic" && m.model === "claude-3-7-sonnet")).toBe(true);
  });

  it("gets and sets active roles dynamically without restart", () => {
    const router = new ProviderRouter(MOCK_CONFIG);
    expect(router.getRole("main")?.model).toBe("claude-3-7-sonnet");

    router.setRole("main", "openai", "gpt-4o");
    expect(router.getRole("main")?.provider).toBe("openai");
    expect(router.getRole("main")?.model).toBe("gpt-4o");
  });
});

describe("Reasoning / Thinking Levels", () => {
  it("defines 5 levels from off to max with proper token mapping", () => {
    expect(REASONING_LEVELS.length).toBe(5);
    const off = REASONING_LEVELS.find((l) => l.id === "off");
    const low = REASONING_LEVELS.find((l) => l.id === "low");
    const med = REASONING_LEVELS.find((l) => l.id === "medium");
    const high = REASONING_LEVELS.find((l) => l.id === "high");
    const max = REASONING_LEVELS.find((l) => l.id === "max");

    expect(off?.tokens).toBe(0);
    expect(low?.tokens).toBe(2048);
    expect(med?.tokens).toBe(8192);
    expect(high?.tokens).toBe(16384);
    expect(max?.tokens).toBe(32768);
  });
});

describe("Session Time-Travel & Forking", () => {
  it("performs FTS5 search across sessions", () => {
    const db = new MemoryDatabase(":memory:");
    const sess1 = db.createSession({ title: "Frontend development", mode: "build" });
    const sess2 = db.createSession({ title: "Backend API routing", mode: "plan" });

    db.saveMessage(sess1.id, {
      id: "msg-1",
      role: "user",
      content: [{ type: "text", text: "Tolong perbaiki styling Tailwind di component Navbar" }],
    });
    db.saveMessage(sess2.id, {
      id: "msg-2",
      role: "user",
      content: [{ type: "text", text: "Buatkan OpenAPI gateway endpoint untuk routing" }],
    });

    const searchHits = db.searchMessages("Tailwind");
    expect(searchHits.length).toBe(1);
    expect(searchHits[0].sessionId).toBe(sess1.id);
    expect(searchHits[0].snippet).toContain("Tailwind");
  });

  it("forks conversation from turn N into a new session", () => {
    const db = new MemoryDatabase(":memory:");
    const source = db.createSession({ title: "Main Architecture", mode: "plan" });

    db.saveMessage(source.id, { id: "m1", role: "user", content: [{ type: "text", text: "Step 1" }] });
    db.saveMessage(source.id, { id: "m2", role: "assistant", content: [{ type: "text", text: "Answer 1" }] });
    db.saveMessage(source.id, { id: "m3", role: "user", content: [{ type: "text", text: "Step 2" }] });
    db.saveMessage(source.id, { id: "m4", role: "assistant", content: [{ type: "text", text: "Answer 2" }] });

    // Fork up to m2 (Turn 1 assistant)
    const forked = db.forkSession(source.id, "m2", "Forked Branch");
    expect(forked.title).toBe("Forked Branch");
    expect(forked.id).not.toBe(source.id);

    const forkedMessages = db.loadMessages(forked.id);
    expect(forkedMessages.length).toBe(2);
    expect(forkedMessages[0].content[0].type === "text" && forkedMessages[0].content[0].text).toBe("Step 1");
    expect(forkedMessages[1].content[0].type === "text" && forkedMessages[1].content[0].text).toBe("Answer 1");
  });

  it("tracks and restores shadow git snapshots", async () => {
    const manager = new SnapshotManager();
    const snapId = await manager.captureSnapshot("test timeline capture");
    expect(snapId).toBeDefined();

    const history = await manager.getHistory();
    expect(history.entries.length).toBeGreaterThan(0);
    expect(history.entries.some((e) => e.id === snapId)).toBe(true);

    const restoreResult = await manager.restoreTo(snapId);
    expect(restoreResult.snapshotId).toBe(snapId);
  });
});
