import { expect, test } from "bun:test";

import { GranularPermissionEngine, permissionRulesFromConfig } from "../src/agent/permissions";
import { planEnterReminder } from "../src/agent/prompt/plan-mode";
import { toolGuidanceText } from "../src/agent/prompt/tools";
import { filterToolsForMode } from "../src/agent/tool-set";
import { createGitInspectTool } from "../src/tools/git-inspect";
import { createLocalHttpProbeTool } from "../src/tools/local-http";

test("Plan favors dedicated inspection without allowing local HTTP requests", () => {
  const tools = [{ name: "git_inspect" }, { name: "probe_local_http" }];
  const planTools = filterToolsForMode(tools, "plan").map((tool) => tool.name);

  expect(planTools).toEqual(["git_inspect"]);
  expect(planEnterReminder("plans")).toContain("git_inspect for Git status and diffs");
  expect(toolGuidanceText(planTools)).toContain("Use git_inspect");
  expect(toolGuidanceText(planTools)).not.toContain("probe_local_http");
  for (const mode of ["build", "ultrawork"] as const) {
    expect(filterToolsForMode(tools, mode)).toEqual(tools);
  }
});

test("Network probes follow execution permissions", async () => {
  const engine = new GranularPermissionEngine();
  const git = createGitInspectTool();
  const probe = createLocalHttpProbeTool();
  const args = { url: "http://127.0.0.1:3000/" };
  const denyExecution = permissionRulesFromConfig([{ action: "execute", effect: "deny", resource: "*" }]);

  expect((await engine.check(git, "plan", { operation: "status" })).allowed).toBe(true);
  expect((await engine.check(probe, "plan", args)).allowed).toBe(false);
  expect((await engine.check(probe, "build", args)).allowed).toBe(true);
  expect((await engine.check(probe, "build", args, denyExecution)).allowed).toBe(false);
});
