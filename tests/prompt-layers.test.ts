import { expect, test } from "bun:test";

import { composePromptParts, composeSystemParts } from "../src/agent/prompt/composer";

test("eager delegation leads with early background dispatch in both prompt styles", () => {
  for (const compact of [false, true]) {
    const options = {
      mode: "build" as const,
      repoRoot: ".",
      tools: ["read_file", "spawn_subagents", "task_wait"],
      delegation: "eager" as const,
      compact,
      extra: "Supplemental instructions",
    };
    const parts = composePromptParts(options);
    const delegationIndex = parts.findIndex(({ key }) => key === "delegation");
    expect(delegationIndex).toBe(1);
    expect(parts[delegationIndex].text).toContain("During initial scoping");
    expect(parts[delegationIndex].text).toContain("before doing their detailed investigation");
    expect(parts[delegationIndex].text).toContain("Fast role when configured");
    expect(parts[delegationIndex].text).toContain("Work on your own slice before calling task_wait");
    const system = composeSystemParts(options);
    const stableIndex = parts.findLastIndex(({ stable }) => stable);
    expect(system.filter(({ cache }) => cache)).toEqual([system[stableIndex]]);
    expect(system[stableIndex].cache).toBe(true);
  }
});

test("delegation remains conditional on policy and available tools", () => {
  const options = { mode: "plan" as const, repoRoot: ".", tools: ["read_file", "spawn_subagents"] };
  const requested = composePromptParts({ ...options, delegation: "requested" }).find(({ key }) => key === "delegation");
  expect(requested?.text).toContain("Delegate only when");
  expect(requested?.text).toContain("In Plan, assign read-only work");
  expect(requested?.text).not.toContain("During initial scoping");
  expect(composePromptParts({ ...options, tools: ["read_file"] }).some(({ key }) => key === "delegation")).toBe(false);
  expect(composePromptParts({ ...options, worker: true }).some(({ key }) => key === "delegation")).toBe(false);
});
