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
      time: "07:45:12 AM GMT+7",
      timezone: "Asia/Jakarta",
      agentInstructions: "# AGENTS\nFollow the project rules.",
      specialistPrompt: "You are Explore, the fast codebase scout.",
      skillsIndex: "<available_skills>\n  <skill>\n    <id>antislop</id>\n  </skill>\n</available_skills>",
      activeSkills: "# Active skills\n- antislop: follow the loaded <skill_content>.",
      extra: "Extra directive",
    });

    expect(prompt).toContain("Working directory: /workspace/project");
    expect(prompt).toContain("Git branch: main");
    expect(prompt).toContain("Platform: linux");
    expect(prompt).toContain("Date: 2026-10-19");
    expect(prompt).toContain("Local time: 07:45:12 AM GMT+7");
    expect(prompt).toContain("Timezone: Asia/Jakarta");
    expect(prompt).toContain("# Capability");
    expect(prompt).toContain("general-purpose agent");
    expect(prompt).toContain("# Tool calls");
    expect(prompt).toContain("Never write a command or tool call as a Markdown code block");
    expect(prompt).toContain("environment block already includes");
    expect(prompt).toContain("Follow the project rules");
    expect(prompt).toContain("Read a file before editing it");
    expect(prompt).toContain("hash_edit");
    expect(prompt).toContain("You are Explore");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<id>antislop</id>");
    expect(prompt).toContain("# Active skills");
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

  it("builds a compact prompt for small local models", () => {
    const prompt = buildSystemPrompt({
      mode: "build",
      repoRoot: "/workspace/project",
      branch: "main",
      date: "2026-10-19",
      time: "09:30:00 AM GMT+7",
      timezone: "Asia/Jakarta",
      compact: true,
      agentInstructions: "This long project instruction should be omitted.",
      skillsIndex: "<available_skills>\n  <skill>\n    <id>archify</id>\n  </skill>\n</available_skills>",
      activeSkills: "# Active skills\n- archify: follow the loaded <skill_content>.",
      extra: "Extra compact directive",
    });

    expect(prompt).toContain("Orchivox");
    expect(prompt).toContain("Local time: 09:30:00 AM GMT+7");
    expect(prompt).toContain("native tool call");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("# Active skills");
    expect(prompt).toContain("Extra compact directive");
    expect(prompt).not.toContain("# Capability");
    expect(prompt).not.toContain("This long project instruction should be omitted");
  });
});
