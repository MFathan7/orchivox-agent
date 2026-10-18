import { describe, expect, it } from "bun:test";
import {
  GranularPermissionEngine,
  parseToolRule,
  evaluateShellRisk,
  calculateDiffPreview,
  type ApprovalRequest,
  type ApprovalDecision,
} from "../src/agent/permissions";
import { ToolRegistry } from "../src/tools/registry";

describe("Granular Permission Engine", () => {
  it("parses per-tool rule patterns correctly", () => {
    const allowRule = parseToolRule("bash(git status*) -> allow");
    expect(allowRule.toolName).toBe("bash");
    expect(allowRule.pattern).toBe("git status*");
    expect(allowRule.action).toBe("allow");

    const askRule = parseToolRule("bash(rm *) -> ask");
    expect(askRule.toolName).toBe("bash");
    expect(askRule.pattern).toBe("rm *");
    expect(askRule.action).toBe("ask");

    const denyRule = parseToolRule("bash(rm -rf /*) -> deny");
    expect(denyRule.toolName).toBe("bash");
    expect(denyRule.pattern).toBe("rm -rf /*");
    expect(denyRule.action).toBe("deny");
  });

  it("evaluates shell command risks accurately", () => {
    const fatal1 = evaluateShellRisk("rm -rf /", "/tmp");
    expect(fatal1.riskLevel).toBe("critical");

    const fatal2 = evaluateShellRisk("git push origin main --force", "/tmp");
    expect(fatal2.riskLevel).toBe("critical");

    const high = evaluateShellRisk("rm src/foo.ts", "/tmp");
    expect(high.riskLevel).toBe("high");

    const medium = evaluateShellRisk("git checkout -b feat/test", "/tmp");
    expect(medium.riskLevel).toBe("medium");

    const low = evaluateShellRisk("git status -s", "/tmp");
    expect(low.riskLevel).toBe("low");
  });

  it("enforces plan mode rules (only read-only allowed)", async () => {
    const engine = new GranularPermissionEngine();
    const readOnlyTool = { name: "read_file", readOnly: true };
    const mutatingTool = { name: "hash_edit", readOnly: false };

    const planRead = await engine.checkPermission(readOnlyTool, { filePath: "src/index.ts" }, "plan");
    expect(planRead.allowed).toBe(true);

    const planMutate = await engine.checkPermission(mutatingTool, { filePath: "src/index.ts" }, "plan");
    expect(planMutate.allowed).toBe(false);
    expect(planMutate.reason).toContain("read-only");
  });

  it("auto-approves in ultrawork mode except for fatal commands", async () => {
    const engine = new GranularPermissionEngine();
    const shellTool = { name: "bash", readOnly: false };

    const normalShell = await engine.checkPermission(shellTool, { command: "bun test" }, "ultrawork");
    expect(normalShell.allowed).toBe(true);

    const fatalShell = await engine.checkPermission(shellTool, { command: "rm -rf /" }, "ultrawork");
    expect(fatalShell.allowed).toBe(false);
    expect(fatalShell.reason).toContain("ULTRAWORK");
  });

  it("prompts for interactive approval in build mode and handles decisions", async () => {
    const engine = new GranularPermissionEngine();
    const shellTool = { name: "bash", readOnly: false };

    let promptedRequest: ApprovalRequest | undefined;
    engine.setApprovalHandler(async (req) => {
      promptedRequest = req;
      return { approved: true, choice: "approve_once" };
    });

    const res = await engine.checkPermission(shellTool, { command: "git reset --hard HEAD" }, "build");
    expect(res.allowed).toBe(true);
    expect(promptedRequest).toBeDefined();
    expect(promptedRequest?.toolName).toBe("bash");
  });

  it("supports session allowlist when user selects always_allow", async () => {
    const engine = new GranularPermissionEngine();
    const shellTool = { name: "bash", readOnly: false };
    let promptCount = 0;

    engine.setApprovalHandler(async () => {
      promptCount += 1;
      return { approved: true, choice: "always_allow" };
    });

    // First call prompts user
    const first = await engine.checkPermission(shellTool, { command: "git checkout dev" }, "build");
    expect(first.allowed).toBe(true);
    expect(promptCount).toBe(1);

    // Second call with same command is auto-approved from session allowlist without prompt
    const second = await engine.checkPermission(shellTool, { command: "git checkout dev" }, "build");
    expect(second.allowed).toBe(true);
    expect(promptCount).toBe(1);
  });

  it("handles deny with feedback and propagates feedback back to AI", async () => {
    const engine = new GranularPermissionEngine();
    const shellTool = { name: "bash", readOnly: false };

    engine.setApprovalHandler(async () => {
      return {
        approved: false,
        choice: "deny_with_feedback",
        feedback: "Jangan hapus file konfigurasi ini, gunakan flag --dry-run dulu.",
      };
    });

    const res = await engine.checkPermission(shellTool, { command: "rm config.json" }, "build");
    expect(res.allowed).toBe(false);
    expect(res.feedback).toContain("dry-run");

    // Also verify ToolRegistry returns this feedback in the tool call error response
    const registry = new ToolRegistry({ permissions: engine });
    registry.register({
      name: "bash",
      description: "shell",
      parameters: { safeParse: () => ({ success: true, data: {} }) } as any,
      readOnly: false,
      execute: () => "ok",
    });

    const toolResult = await registry.run(
      { id: "call-1", name: "bash", arguments: { command: "rm config.json" } },
      "build",
    );
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain("dry-run");
  });

  it("computes live diff preview for file editing tools", async () => {
    const preview = await calculateDiffPreview(
      "write_file",
      { filePath: "package.json", content: '{\n  "name": "orchivox-agent-modified"\n}' },
      process.cwd(),
    );

    expect(preview).toBeDefined();
    expect(preview?.filePath).toBe("package.json");
    expect(preview?.oldText).toContain("orchivox-agent");
    expect(preview?.newText).toContain("orchivox-agent-modified");
  });
});
