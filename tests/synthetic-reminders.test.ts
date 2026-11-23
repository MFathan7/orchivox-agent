import { expect, test } from "bun:test";

import { GranularPermissionEngine, permissionRulesFromConfig } from "../src/agent/permissions";
import { planEnterReminder } from "../src/agent/prompt/plan-mode";
import { toolGuidanceText } from "../src/agent/prompt/tools";
import { filterToolsForMode } from "../src/agent/tool-set";
import { createGitInspectTool } from "../src/tools/git-inspect";
import { createLocalHttpProbeTool } from "../src/tools/local-http";
import { PersistentShellTool } from "../src/tools/shell";
import { detectShell } from "../src/tools/shell-adapter";

test("Plan favors dedicated inspection without allowing local HTTP requests", () => {
  const tools = [{ name: "git_inspect" }, { name: "probe_local_http" }];
  const planTools = filterToolsForMode(tools, "plan").map((tool) => tool.name);

  expect(planTools).toEqual(["git_inspect"]);
  expect(planEnterReminder("plans")).toContain("git_inspect for Git status and diffs");
  expect(planEnterReminder("plans")).toContain("Sort-Object, Select-Object, Format-Table, or Format-List");
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

const shellAdapter = detectShell({ platform: "win32", env: {}, exists: (name) => name === "powershell.exe" });
const planShellEngine = new GranularPermissionEngine({ shellAdapter });
const shell = new PersistentShellTool({ adapter: shellAdapter });

test.each([
  "Get-ChildItem -Recurse work -File | Sort-Object Length -Descending | Select-Object -First 30 FullName,Length | Format-Table -AutoSize",
  "Get-ChildItem -Recurse work -File | Select-Object FullName,Length",
  "Get-ChildItem work\\asar, work\\patch, work\\web, work\\backup -File | Format-Table Length, Name -AutoSize",
  "Get-Command git -ErrorAction SilentlyContinue | Format-List Name, CommandType, Source, Version",
  "Get-Item -LiteralPath 'work{old}' | Select-Object FullName,Length",
])("Plan permits static PowerShell inspection: %s", async (command) => {
  expect(await planShellEngine.check(shell, "plan", { command })).toEqual({ allowed: true });
});

test.each([
  "Get-ChildItem -File | ForEach-Object { $_.Name }",
  "Get-ChildItem -File | Sort-Object { $_.Length }",
  "Get-ChildItem -File | Select-Object @{Name='Size'; Expression={ $_.Length }}",
  "Get-ChildItem -File | Format-Table -GroupBy { $_.Extension }",
  "Get-ChildItem -File | Select-Object @selection",
  "Get-ChildItem -File | Select-Object -First 5 -OutVariable inspection",
  "Get-ChildItem -File | Select-Object -First 5 –OutVariable inspection",
  "Get-ChildItem -File | Format-List > files.txt",
  "Get-ChildItem -File | Format-Table | Out-File files.txt",
])("Plan rejects dynamic or state-changing PowerShell: %s", async (command) => {
  expect(await planShellEngine.check(shell, "plan", { command })).toMatchObject({ allowed: false });
});
