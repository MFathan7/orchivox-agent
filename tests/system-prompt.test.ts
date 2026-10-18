import { describe, expect, it } from "bun:test";

import { buildSystemPrompt, MODE_PROMPTS } from "../src/agent/system-prompt";

describe("system prompt builder", () => {
  it("includes environment, instructions, tool discipline, specialist, and style", () => {
    const prompt = buildSystemPrompt({
      mode: "build",
      repoRoot: "/workspace/project",
      branch: "main",
      platform: "linux",
      shell: "/bin/bash",
      date: "2026-10-19",
      agentInstructions: "# AGENTS\nFollow the project rules.",
      specialistPrompt: "You are Explore, the fast codebase scout.",
      skillsIndex: "# Skills\n- antislop: stop generic output",
      extra: "Extra directive",
    });

    expect(prompt).toContain("Working directory: /workspace/project");
    expect(prompt).toContain("Git branch: main");
    expect(prompt).toContain("Platform: linux");
    expect(prompt).toContain("Date: 2026-10-19");
    expect(prompt).toContain("Follow the project rules");
    expect(prompt).toContain("Read a file before editing it");
    expect(prompt).toContain("hash_edit");
    expect(prompt).toContain("You are Explore");
    expect(prompt).toContain("antislop");
    expect(prompt).toContain("Extra directive");
    expect(prompt).toContain("Do not use em dashes");
    expect(prompt).toContain(MODE_PROMPTS.build);
  });

  it("omits optional sections that are empty", () => {
    const prompt = buildSystemPrompt({ mode: "plan", repoRoot: "/workspace" });
    expect(prompt).toContain(MODE_PROMPTS.plan);
    expect(prompt).not.toContain("# Project instructions");
    expect(prompt).not.toContain("# Active agent");
    expect(prompt).not.toContain("# Skills");
  });
});
