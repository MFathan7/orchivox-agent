import { describe, expect, it } from "bun:test";

import { SKILL_ALWAYS_ALLOWED_TOOLS, SkillToolPolicy } from "../src/agent/skill-policy";
import { StreamEventSchema } from "../src/types/schema";

const tools = [
  { name: "read_file" },
  { name: "hash_edit" },
  { name: "shell" },
  { name: "skill" },
  { name: "todo_write" },
];

describe("Skill tool policy", () => {
  it("allows every tool before a skill is active", () => {
    const policy = new SkillToolPolicy(["skill", "todo_write"]);
    expect(policy.active).toBe(false);
    expect(policy.allows("hash_edit")).toBe(true);
    expect(policy.filter(tools)).toEqual(tools);
  });

  it("limits tools after activation and keeps always-allowed tools", () => {
    const policy = new SkillToolPolicy(["skill", "todo_write"]);
    policy.activate(["read_file"]);
    expect(policy.active).toBe(true);
    expect(policy.allows("read_file")).toBe(true);
    expect(policy.allows("hash_edit")).toBe(false);
    expect(policy.allows("skill")).toBe(true);
    expect(policy.allows("todo_write")).toBe(true);
    expect(policy.filter(tools).map((tool) => tool.name)).toEqual(["read_file", "skill", "todo_write"]);
  });

  it("unions multiple skills", () => {
    const policy = new SkillToolPolicy(["skill"]);
    policy.activate(["read_file"]);
    policy.activate(["shell"]);
    expect(policy.allows("read_file")).toBe(true);
    expect(policy.allows("shell")).toBe(true);
    expect(policy.filter(tools).map((tool) => tool.name)).toEqual(["read_file", "shell", "skill"]);
  });

  it("treats an empty allowed list as strict", () => {
    const policy = new SkillToolPolicy(["skill"]);
    policy.activate([]);
    expect(policy.allows("read_file")).toBe(false);
    expect(policy.allows("skill")).toBe(true);
    expect(policy.filter(tools).map((tool) => tool.name)).toEqual(["skill"]);
  });

  it("exports the default always-allowed tools", () => {
    expect(SKILL_ALWAYS_ALLOWED_TOOLS).toContain("skill");
    expect(SKILL_ALWAYS_ALLOWED_TOOLS).toContain("skill_list");
    expect(SKILL_ALWAYS_ALLOWED_TOOLS).toContain("todo_write");
    expect(SKILL_ALWAYS_ALLOWED_TOOLS).toContain("todo_read");
    expect(SKILL_ALWAYS_ALLOWED_TOOLS).toContain("read_file");
    expect(SKILL_ALWAYS_ALLOWED_TOOLS).not.toContain("web_search");
  });

  it("parses the skill activation stream event", () => {
    expect(
      StreamEventSchema.safeParse({
        type: "skill_activated",
        name: "pdf",
        allowed_tools: ["read_file"],
      }).success,
    ).toBe(true);
    expect(StreamEventSchema.safeParse({ type: "skill_activated", name: "pdf" }).success).toBe(true);
  });
});
