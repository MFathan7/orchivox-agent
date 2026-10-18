import { afterEach, describe, expect, it } from "bun:test";
import React from "react";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { loadConfig, parseConfig } from "../src/config/loader";
import { saveProviderProfile, saveRoleSelection } from "../src/config/writer";
import { ProviderRouter } from "../src/provider/router";
import { OrchivoxApp, computeViewportHeight } from "../src/tui/app";
import {
  findNextWordEnd,
  findPreviousWordStart,
  PersistentCommandHistory,
  splitLineAtCursor,
} from "../src/tui/composer";
import { CommandPaletteModal } from "../src/tui/command-palette";
import { buildHelpLines, HelpOverlay } from "../src/tui/help-overlay";
import { ModelConfigModal } from "../src/tui/model-modal";
import { getTheme, THEME_ORDER } from "../src/tui/theme";
import { estimateEntryLines } from "../src/tui/viewport";

const createdDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orchivox-phase02-"));
  createdDirs.push(dir);
  return dir;
}

function renderToText(element: React.ReactElement): { text: string; unmount: () => void } {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });
  const instance = render(element, {
    stdout: stream as unknown as NodeJS.WriteStream,
    patchConsole: false,
  });
  return {
    get text() {
      return output;
    },
    unmount: () => instance.unmount(),
  };
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Help overlay", () => {
  it("builds sections in a readable order", () => {
    const lines = buildHelpLines();
    const sections = lines.filter((line) => line.kind === "section").map((line) => line.text);
    expect(sections).toEqual(["Commands", "Editing", "Panels", "Custom commands"]);
    expect(lines.some((line) => line.kind === "row" && line.keys.trim() === "/models")).toBe(true);
  });

  it("renders inside Ink without dumping into the transcript", () => {
    const view = renderToText(
      React.createElement(HelpOverlay, { theme: getTheme("tokyonight"), width: 90, height: 40, onClose: () => undefined }),
    );
    expect(view.text).toContain("Commands");
    expect(view.text).toContain("/models");
    expect(view.text).toContain("PageUp/PageDown");
    view.unmount();
  });
});

describe("Command palette", () => {
  const router = new ProviderRouter(
    parseConfig({
      providers: {},
      roles: {},
    }),
  );

  it("shows only actions before the user types", () => {
    const view = renderToText(
      React.createElement(CommandPaletteModal, {
        router,
        onClose: () => undefined,
        theme: getTheme("tokyonight"),
      }),
    );
    expect(view.text).toContain("Model manager");
    expect(view.text).toContain("Sessions");
    expect(view.text).not.toContain("main:");
    view.unmount();
  });
});

describe("Model manager", () => {
  it("shows a clear empty state when no provider is connected", () => {
    const router = new ProviderRouter(parseConfig({ providers: {}, roles: {} }));
    const view = renderToText(
      React.createElement(ModelConfigModal, {
        router,
        configPath: "/tmp/unused-config.yaml",
        secretsPath: "/tmp/unused-secrets.yaml",
        theme: getTheme("tokyonight"),
        onClose: () => undefined,
      }),
    );
    expect(view.text).toContain("Local models");
    expect(view.text).toContain("Another platforms");
    expect(view.text).toContain("not configured");
    expect(view.text).toContain("OpenAI");
    view.unmount();
  });
});

describe("App layout", () => {
  it("keeps the viewport and composer inside the terminal", () => {
    expect(computeViewportHeight(24, 3, 4)).toBe(16);
    expect(computeViewportHeight(24, 3, 14)).toBe(6);
    expect(computeViewportHeight(10, 3, 14)).toBe(3);
  });

  it("renders the welcome banner and composer together", () => {
    const view = renderToText(
      React.createElement(OrchivoxApp, {
        entries: [],
        mode: "build",
        onSubmit: () => undefined,
      }),
    );
    expect(view.text).toContain("ORCHIVOX");
    expect(view.text).toContain("Type a prompt to begin.");
    view.unmount();
  });
});

describe("Composer word navigation", () => {
  it("walks backwards across words and punctuation", () => {
    const text = "const value = foo(bar);";
    expect(findPreviousWordStart(text, text.length)).toBe(text.indexOf("bar"));
    expect(findPreviousWordStart("hello world", 11)).toBe(6);
    expect(findPreviousWordStart("hello", 0)).toBe(0);
  });

  it("walks forwards across words and punctuation", () => {
    expect(findNextWordEnd("hello world", 0)).toBe(5);
    expect(findNextWordEnd("hello   world", 5)).toBe(13);
    expect(findNextWordEnd("foo();", 3)).toBe(6);
    expect(findNextWordEnd("orchivox", 8)).toBe(8);
  });

  it("never splits a surrogate pair at the cursor", () => {
    const parts = splitLineAtCursor("a😀b", 2);
    expect(parts.before).toBe("a😀");
    expect(parts.cursorChar).toBe("b");
    expect(parts.after).toBe("");
  });
});

describe("Composer history", () => {
  it("loads history synchronously so Up works on the first frame", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "history.json");
    await writeFile(path, JSON.stringify(["first prompt", "second prompt"]));
    const history = new PersistentCommandHistory(path, dir);
    expect(history.getPrevious("draft")).toBe("second prompt");
    expect(history.getPrevious("draft")).toBe("first prompt");
  });
});

describe("Viewport height estimate", () => {
  it("counts wrapped lines per logical line", () => {
    const entry = { id: "e1", role: "system" as const, text: `${"a".repeat(100)}\n${"b".repeat(50)}` };
    expect(estimateEntryLines(entry, 50, false)).toBe(3);
  });
});

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const red = Number.parseInt(clean.slice(0, 2), 16);
  const green = Number.parseInt(clean.slice(2, 4), 16);
  const blue = Number.parseInt(clean.slice(4, 6), 16);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Theme contrast", () => {
  it("keeps text and muted hints readable on each theme background", () => {
    for (const name of THEME_ORDER) {
      const theme = getTheme(name);
      expect(contrastRatio(theme.text, theme.background)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(theme.muted, theme.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.syntax.comment, theme.background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("Application shell", () => {
  const router = new ProviderRouter(parseConfig({ providers: {}, roles: {} }));

  it("renders the header, mode line, and composer without a modal", () => {
    const view = renderToText(
      React.createElement(OrchivoxApp, {
        entries: [],
        router,
        projectName: "demo-project",
        branch: "main",
      }),
    );
    expect(view.text).toContain("demo-project");
    expect(view.text).toContain("BUILD");
    expect(view.text).toContain("Tab mode");
    view.unmount();
  });

  it("renders the help panel instead of the transcript when help is open", () => {
    const view = renderToText(
      React.createElement(OrchivoxApp, {
        entries: [],
        router,
        projectName: "demo-project",
        helpOpen: true,
      }),
    );
    expect(view.text).toContain("Commands");
    expect(view.text).toContain("/models");
    expect(view.text).toContain("Up/Down scroll");
    expect(view.text).not.toContain("Tab mode");
    view.unmount();
  });
});

describe("Provider config writer", () => {
  it("saves a provider, keeps existing comments, and stores the key separately", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "config.yaml");
    const secretsPath = join(dir, "secrets.yaml");
    await writeFile(
      configPath,
      ["# keep this comment", "version: 1", "providers: {}", "roles: {}", ""].join("\n"),
    );

    await saveProviderProfile({
      configPath,
      secretsPath,
      name: "local_ollama",
      profile: {
        kind: "ollama",
        base_url: "http://127.0.0.1:11434/v1",
        models: ["qwen2.5-coder:7b"],
        headers: {},
        timeout_ms: 60000,
        enabled: true,
      },
      apiKey: "secret-key",
    });

    const configRaw = await readFile(configPath, "utf8");
    expect(configRaw).toContain("# keep this comment");
    expect(configRaw).toContain("local_ollama");
    expect(configRaw).not.toContain("secret-key");

    const secretsRaw = await readFile(secretsPath, "utf8");
    expect(secretsRaw).toContain("secret-key");

    const loaded = await loadConfig(configPath, {}, { secretsPath });
    expect(loaded.providers.local_ollama?.models).toEqual(["qwen2.5-coder:7b"]);
    expect(loaded.providers.local_ollama?.api_key).toBe("secret-key");
  });

  it("persists a role selection", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "config.yaml");
    await writeFile(configPath, "version: 1\nproviders: {}\nroles: {}\n");

    await saveRoleSelection(configPath, "main", "openai_primary", "gpt-4.1");
    const loaded = await loadConfig(configPath, {});
    expect(loaded.roles.main_model).toEqual({ provider: "openai_primary", model: "gpt-4.1" });
  });
});
