import { afterEach, describe, expect, it } from "bun:test";
import React from "react";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { GranularPermissionEngine } from "../src/agent/permissions";
import { stripImageBlocks } from "../src/agent/orchestrator";
import { SkillRegistry } from "../src/agent/skills";
import { inferModelCapabilities, loadConfig, parseConfig } from "../src/config/loader";
import { saveModelCapabilities } from "../src/config/writer";
import { MemoryDatabase } from "../src/memory/sqlite";
import { estimateMessageTokens } from "../src/memory/hindsight";
import { toAnthropicMessages } from "../src/provider/anthropic-compat";
import { toOpenAiMessages } from "../src/provider/openai-compat";
import { ProviderRouter } from "../src/provider/router";
import { buildInjectedContext, imageMimeType, loadImageAttachments, resolveFileAttachments } from "../src/tui/composer";
import { getTheme } from "../src/tui/theme";
import { formatCost, formatTokenCount } from "../src/tui/format";
import { estimateEntryLines, ScrollableChatViewport } from "../src/tui/viewport";
import { callVisionProvider } from "../src/tools/vision";
import { ChatRequestSchema, StreamEventSchema } from "../src/types/schema";

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Token formatting", () => {
  it("formats compact and exact counts", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1_200)).toBe("1.2k");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
    expect(formatTokenCount(1_234, false)).toBe("1,234");
    expect(formatCost(0)).toBe("$0.0000");
    expect(formatCost(0.00001)).toBe("<$0.0001");
  });
});

describe("Model capabilities", () => {
  it("infers reasoning and vision from model names", () => {
    expect(inferModelCapabilities("ollama", "deepseek-r1:7b").reasoning).toBe(true);
    expect(inferModelCapabilities("ollama", "qwen2.5-vl:7b").vision).toBe(true);
    expect(inferModelCapabilities("ollama", "llama3.2:3b").tool_calling).toBe(true);
  });

  it("resolves explicit overrides for a role", () => {
    const config = parseConfig({
      providers: {
        local: {
          kind: "ollama",
          base_url: "http://127.0.0.1:11434/v1",
          models: ["llama3.2:3b"],
          model_capabilities: {
            "llama3.2:3b": { tool_calling: false, reasoning: true, context_window: 8192 },
          },
        },
      },
      roles: { main_model: { provider: "local", model: "llama3.2:3b" } },
    });
    const router = new ProviderRouter(config);
    const capabilities = router.capabilitiesForRole("main");
    expect(capabilities.tool_calling).toBe(false);
    expect(capabilities.reasoning).toBe(true);
    expect(capabilities.context_window).toBe(8192);
  });

  it("keeps inferred fields when an override is partial", () => {
    const config = parseConfig({
      providers: {
        local: {
          kind: "ollama",
          base_url: "http://127.0.0.1:11434/v1",
          models: ["deepseek-r1:7b"],
          model_capabilities: {
            "deepseek-r1:7b": { vision: true },
          },
        },
      },
      roles: { main_model: { provider: "local", model: "deepseek-r1:7b" } },
    });
    const capabilities = new ProviderRouter(config).capabilitiesForRole("main");
    expect(capabilities.vision).toBe(true);
    expect(capabilities.reasoning).toBe(true);
    expect(capabilities.tool_calling).toBe(true);
  });

  it("persists, updates, and resets an override without dropping comments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orchivox-caps-"));
    createdDirs.push(dir);
    const configPath = join(dir, "config.yaml");
    const secretsPath = join(dir, "secrets.yaml");
    await writeFile(
      configPath,
      [
        "# keep this comment",
        "version: 1",
        "providers:",
        "  local:",
        "    kind: ollama",
        "    base_url: http://127.0.0.1:11434/v1",
        "    models:",
        "      - deepseek-r1:7b",
        "roles:",
        "  main_model:",
        "    provider: local",
        "    model: deepseek-r1:7b",
        "",
      ].join("\n"),
    );

    await saveModelCapabilities(configPath, "local", "deepseek-r1:7b", { vision: true });
    let loaded = await loadConfig(configPath, {}, { secretsPath });
    expect(loaded.providers.local?.model_capabilities["deepseek-r1:7b"]?.vision).toBe(true);
    expect(loaded.providers.local?.model_capabilities["deepseek-r1:7b"]?.reasoning).toBeUndefined();
    expect(await readFile(configPath, "utf8")).toContain("# keep this comment");

    const router = new ProviderRouter(loaded);
    expect(router.capabilitiesFor("local", "deepseek-r1:7b").reasoning).toBe(true);
    router.setModelCapabilities("local", "deepseek-r1:7b", { tool_calling: false });
    expect(router.capabilitiesFor("local", "deepseek-r1:7b").tool_calling).toBe(false);
    router.setModelCapabilities("local", "deepseek-r1:7b", undefined);
    expect(router.capabilitiesOverrideFor("local", "deepseek-r1:7b")).toBeUndefined();
    expect(router.capabilitiesFor("local", "deepseek-r1:7b").tool_calling).toBe(true);

    await saveModelCapabilities(configPath, "local", "deepseek-r1:7b", undefined);
    loaded = await loadConfig(configPath, {}, { secretsPath });
    expect(loaded.providers.local?.model_capabilities["deepseek-r1:7b"]).toBeUndefined();
  });
});

describe("Mode permissions", () => {
  const writeTool = { name: "hash_edit", readOnly: false };
  const readTool = { name: "read_file", readOnly: true };

  it("blocks writes in plan mode and allows reads", async () => {
    const engine = new GranularPermissionEngine({ repoRoot: process.cwd() });
    expect((await engine.check(writeTool, "plan")).allowed).toBe(false);
    expect((await engine.check(readTool, "plan")).allowed).toBe(true);
  });

  it("allows writes in ultrawork but denies critical shell commands", async () => {
    const engine = new GranularPermissionEngine({ repoRoot: process.cwd() });
    expect((await engine.check(writeTool, "ultrawork")).allowed).toBe(true);
    const critical = await engine.check(
      { name: "bash", readOnly: false },
      "ultrawork",
      { command: "rm -rf /" },
    );
    expect(critical.allowed).toBe(false);
  });

  it("asks for approval before writes in build mode", async () => {
    const engine = new GranularPermissionEngine({ repoRoot: process.cwd() });
    let asked = false;
    engine.setApprovalHandler(async () => {
      asked = true;
      return { approved: true, choice: "approve_once" };
    });
    const decision = await engine.check(writeTool, "build", { filePath: "/tmp/orchivox-mode-test.txt" });
    expect(asked).toBe(true);
    expect(decision.allowed).toBe(true);
  });
});

describe("Stream activity events", () => {
  it("parses tool and file change events", () => {    expect(
      StreamEventSchema.safeParse({
        type: "tool_start",
        id: "call-1",
        name: "read_file",
        arguments_summary: "{}",
      }).success,
    ).toBe(true);
    expect(
      StreamEventSchema.safeParse({
        type: "tool_end",
        id: "call-1",
        name: "read_file",
        status: "ok",
        duration_ms: 12,
      }).success,
    ).toBe(true);
    expect(
      StreamEventSchema.safeParse({
        type: "file_change",
        path: "src/a.ts",
        old_text: "",
        new_text: "export {};\n",
        additions: 1,
        deletions: 0,
      }).success,
    ).toBe(true);
  });
});

describe("Skill discovery roots", () => {
  it("reads ORCHIVOX_SKILLS_PATH and does not scan other platform folders", async () => {
    const repo = await mkdtemp(join(tmpdir(), "orchivox-skills-repo-"));
    const extra = await mkdtemp(join(tmpdir(), "orchivox-skills-extra-"));
    createdDirs.push(repo, extra);

    await mkdir(join(extra, "deploy"), { recursive: true });
    await writeFile(
      join(extra, "deploy", "SKILL.md"),
      ["---", "name: deploy", "description: Deploy it safely.", "---", "", "# Deploy", ""].join("\n"),
    );
    await mkdir(join(repo, ".claude", "skills", "legacy"), { recursive: true });
    await writeFile(
      join(repo, ".claude", "skills", "legacy", "SKILL.md"),
      ["---", "name: legacy", "description: Other platform only.", "---", "", "# Legacy", ""].join("\n"),
    );

    const previous = process.env.ORCHIVOX_SKILLS_PATH;
    process.env.ORCHIVOX_SKILLS_PATH = extra;
    try {
      const registry = new SkillRegistry({ repoRoot: repo, includeGlobalDirectories: false });
      const documents = await registry.load(true);
      expect(documents.map((document) => document.name)).toContain("deploy");
      expect(documents.find((document) => document.name === "deploy")?.scope).toBe("custom");
      expect(documents.map((document) => document.name)).not.toContain("legacy");
    } finally {
      if (previous === undefined) delete process.env.ORCHIVOX_SKILLS_PATH;
      else process.env.ORCHIVOX_SKILLS_PATH = previous;
    }
  });
});

describe("Live activity rendering", () => {
  it("counts live, tool, and file rows in the height estimate", () => {
    const base = estimateEntryLines({ id: "a", role: "assistant", text: "one line" }, 80, false);
    const live = estimateEntryLines(
      {
        id: "live",
        role: "assistant",
        text: "one line",
        live: true,
        toolCalls: [{ name: "read_file", argumentsSummary: "{}", status: "running" }],
        files: [{ path: "a.ts", oldText: "", newText: "x", additions: 1, deletions: 0 }],
      },
      80,
      false,
    );
    expect(live).toBeGreaterThan(base);
  });

  it("renders a live turn with tool and file activity", () => {
    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });

    const instance = render(
      React.createElement(ScrollableChatViewport, {
        entries: [],
        liveEntry: {
          id: "live",
          role: "assistant",
          text: "partial answer",
          thinking: "checking the file",
          toolCalls: [{ id: "call-1", name: "read_file", argumentsSummary: "{}", status: "running" }],
          files: [
            {
              path: "src/a.ts",
              oldText: "",
              newText: "export {};\n",
              additions: 1,
              deletions: 0,
            },
          ],
          live: true,
          startedAt: Date.now(),
        },
        width: 80,
        height: 20,
        theme: getTheme("tokyonight"),
      }),
      { stdout: stream as unknown as NodeJS.WriteStream, patchConsole: false },
    );

    expect(output).toContain("Reading file");
    expect(output).toContain("src/a.ts");
    expect(output).toContain("partial answer");
    instance.unmount();
  });
});

describe("Vision blocks", () => {
  const image = {
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/png", data: "AAAA" },
    path: "shot.png",
  };
  const request = ChatRequestSchema.parse({
    messages: [
      {
        id: "u1",
        role: "user",
        content: [image, { type: "text", text: "describe" }],
      },
    ],
    max_tokens: 16,
  });

  it("maps image blocks for OpenAI", () => {
    const messages = toOpenAiMessages(request);
    expect(messages[0]?.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "text", text: "describe" },
    ]);
  });

  it("maps image blocks for Anthropic", () => {
    const { messages } = toAnthropicMessages(request);
    expect(messages[0]?.content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });

  it("replaces images with a text note for non-vision models", () => {
    const stripped = stripImageBlocks(request.messages);
    const first = stripped[0]?.content[0];
    expect(first?.type).toBe("text");
    if (first?.type === "text") {
      expect(first.text).toContain("inspect_image");
      expect(first.text).toContain("shot.png");
    }
  });

  it("does not persist inline image data in the database", () => {
    const database = new MemoryDatabase(":memory:");
    const session = database.createSession({ title: "vision", mode: "build" });
    database.saveMessage(session.id, request.messages[0] as (typeof request.messages)[number]);
    const loaded = database.loadMessages(session.id);
    expect(loaded[0]?.content[0]).toEqual({ type: "text", text: "[image: shot.png]" });
  });

  it("counts image tokens in the context estimate", () => {
    expect(estimateMessageTokens(request.messages[0] as (typeof request.messages)[number])).toBeGreaterThanOrEqual(1000);
  });
});

describe("Image attachments", () => {
  it("detects image extensions and loads base64 without injecting text context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orchivox-image-"));
    createdDirs.push(dir);
    await writeFile(join(dir, "shot.png"), new Uint8Array([1, 2, 3, 4]));

    expect(imageMimeType("shot.png")).toBe("image/png");
    expect(imageMimeType("notes.md")).toBeUndefined();

    const refs = await resolveFileAttachments([{ raw: "@shot.png", filePath: "shot.png" }], dir);
    expect(refs[0]?.kind).toBe("image");
    expect(refs[0]?.mimeType).toBe("image/png");

    const loaded = await loadImageAttachments(refs, dir);
    expect(loaded[0]?.base64).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));

    const context = await buildInjectedContext(loaded, dir);
    expect(context).toBe("");
  });

  it("refuses to analyze an image with a non-vision model", async () => {
    const config = parseConfig({
      providers: {
        local: {
          kind: "ollama",
          base_url: "http://127.0.0.1:11434/v1",
          models: ["llama3.2:3b"],
        },
      },
      roles: { main_model: { provider: "local", model: "llama3.2:3b" } },
    });
    const router = new ProviderRouter(config);
    const result = await callVisionProvider({
      router,
      base64Data: "AAAA",
      mimeType: "image/png",
      prompt: "describe",
    });
    expect(result).toContain("does not support vision");
  });
});
