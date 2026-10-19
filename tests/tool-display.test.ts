import { describe, expect, it } from "bun:test";

import { humanizeToolName, toolDisplay } from "../src/agent/tool-display";

describe("tool display", () => {
  it("maps common tools to readable labels and details", () => {
    expect(toolDisplay("read_file", { filePath: "src/a.ts" })).toEqual({
      label: "Reading file",
      detail: "src/a.ts",
    });
    expect(toolDisplay("grep_search", { pattern: "TODO" }).label).toBe("Searching code");
    expect(toolDisplay("bash", { command: "git status" })).toEqual({
      label: "Running command",
      detail: "git status",
    });
    expect(toolDisplay("web_search", { query: "bun" }).label).toBe("Searching the web");
    expect(toolDisplay("web_fetch", { url: "https://example.com/a" })).toEqual({
      label: "Fetching page",
      detail: "example.com",
    });
    expect(toolDisplay("skill", { id: "archify" })).toEqual({
      label: "Loading skill",
      detail: "archify",
    });
  });

  it("humanizes unknown tools", () => {
    expect(toolDisplay("custom_tool").label).toBe("Custom Tool");
    expect(humanizeToolName("lsp_workspace_symbols")).toBe("Lsp Workspace Symbols");
  });

  it("truncates long details", () => {
    const display = toolDisplay("bash", { command: "x".repeat(200) });
    expect(display.detail?.length).toBeLessThanOrEqual(72);
    expect(display.detail?.endsWith("...")).toBe(true);
  });
});
