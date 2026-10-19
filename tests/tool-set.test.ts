import { describe, expect, it } from "bun:test";

import { BUILD_TOOL_NAMES, PLAN_TOOL_NAMES, filterToolsForMode } from "../src/agent/tool-set";

const tools = [
  { name: "read_file" },
  { name: "hash_edit" },
  { name: "bash" },
  { name: "web_search" },
  { name: "task_create" },
  { name: "spawn_subagents" },
  { name: "bg_start" },
];

describe("tool set per mode", () => {
  it("keeps plan focused on read-only tools", () => {
    const names = filterToolsForMode(tools, "plan").map((tool) => tool.name);
    expect(names).toContain("read_file");
    expect(names).toContain("bash");
    expect(names).toContain("web_search");
    expect(names).not.toContain("hash_edit");
    expect(names).not.toContain("task_create");
  });

  it("keeps build core tools and excludes ultrawork-only tools", () => {
    const names = filterToolsForMode(tools, "build").map((tool) => tool.name);
    expect(names).toContain("hash_edit");
    expect(names).toContain("bg_start");
    expect(names).not.toContain("task_create");
    expect(names).not.toContain("spawn_subagents");
  });

  it("keeps every tool in ultrawork", () => {
    expect(filterToolsForMode(tools, "ultrawork")).toHaveLength(tools.length);
  });

  it("has the expected set sizes", () => {
    expect(PLAN_TOOL_NAMES.size).toBe(14);
    expect(BUILD_TOOL_NAMES.size).toBe(22);
  });
});
