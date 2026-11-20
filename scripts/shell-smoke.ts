#!/usr/bin/env bun
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CustomCommandEngine } from "../src/agent/custom-commands";
import { HookRunner } from "../src/agent/hooks";
import { runWithTurnContext } from "../src/agent/turn-context";
import { BackgroundProcessManager } from "../src/tools/bg-process";
import { createGitInspectTool } from "../src/tools/git-inspect";
import { createLocalHttpProbeTool } from "../src/tools/local-http";
import { runToolProcess } from "../src/tools/process";
import { ToolRegistry } from "../src/tools/registry";
import { PersistentShellTool } from "../src/tools/shell";
import type { ShellAdapter } from "../src/tools/shell-adapter";
import { ChatRequestSchema } from "../src/types/schema";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isPowerShell(adapter: ShellAdapter): boolean {
  return adapter.kind === "pwsh" || adapter.kind === "powershell";
}

async function checkGitInspection(root: string): Promise<void> {
  const git = createGitInspectTool();
  check(git.readOnly, "Git inspection must be read-only");
  const runGit = async (...args: string[]) => {
    const result = await runToolProcess(["git", ...args], { cwd: root });
    check(result.code === 0, `git fixture setup failed: ${result.error}`);
  };
  const file = "with spaces.txt";
  await runGit("init");
  await writeFile(join(root, file), "staged version\n");
  await runGit("add", "--", file);
  await writeFile(join(root, file), "working version\n");
  await runWithTurnContext({ mode: "plan", workspaceRoot: root }, async () => {
    const inspect = (args: unknown) => git.execute(git.parameters.parse(args));
    const status = await inspect({ operation: "status" });
    const staged = await inspect({ operation: "diff", staged: true, paths: [file] });
    const unstaged = await inspect({ operation: "diff", paths: [file] });
    check(status.startsWith("AM ") && status.includes(file), `unexpected status:\n${status}`);
    check(staged.includes("+staged version"), `staged changes missing:\n${staged}`);
    check(unstaged.includes("+working version"), `unstaged changes missing:\n${unstaged}`);
  });
}

async function checkLocalService(root: string, shell: PersistentShellTool): Promise<void> {
  const adapter = shell.shell;
  const source = join(root, "smoke server.ts");
  const build = join(root, "smoke server.js");
  const test = join(root, "smoke.test.ts");
  await writeFile(join(root, "smoke-status.ts"), "export const status = 204;\n");
  await writeFile(source, [
    'import { status } from "./smoke-status";',
    'const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status }) });',
    'console.log("ready at " + server.url);',
  ].join("\n"));
  await writeFile(test, [
    'import { expect, test } from "bun:test";',
    'import { status } from "./smoke-status";',
    'test("health status", () => expect(status).toBe(204));',
  ].join("\n"));
  const background = new BackgroundProcessManager({ defaultCwd: root, adapter });
  const prefix = isPowerShell(adapter) ? "& " : "";
  const bun = `${prefix}${adapter.quote(process.execPath)}`;
  const tested = await shell.execute({ command: `${bun} test ${adapter.quote(test)}`, workdir: root });
  check(tested.startsWith("exit 0") && tested.includes("1 pass"), `test failed:\n${tested}`);
  const built = await shell.execute({
    command: `${bun} build ${adapter.quote(source)} --outfile ${adapter.quote(build)} --target bun`,
    workdir: root,
  });
  check(built.startsWith("exit 0") && await Bun.file(build).exists(), `build failed:\n${built}`);
  try {
    const info = await background.start({
      id: "shell-smoke-service",
      command: `${bun} ${adapter.quote(build)}`,
      waitForReadyRegex: "ready at http",
      readyTimeoutMs: 5000,
    });
    const url = info.listeningUrls.find((entry) => entry.startsWith("http://127.0.0.1:"));
    check(info.status === "ready" && url, `local service failed to start:\n${background.getLogs(info.id).formatted}`);
    const probe = createLocalHttpProbeTool();
    const status = await probe.execute(probe.parameters.parse({ url }));
    check(status === "HTTP 204", `unexpected HTTP response: ${status}`);
    const localhost = url.replace("127.0.0.1", "localhost");
    check(await probe.execute(probe.parameters.parse({ url: localhost })) === status, "localhost probe failed");
    await background.stop(info.id, true);
    const deadline = Date.now() + 3000;
    while (true) {
      try {
        await probe.execute(probe.parameters.parse({ url, timeoutMs: 500 }));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ECONNREFUSED") break;
        throw error;
      }
      check(Date.now() < deadline, "local service remained reachable after stop");
      await Bun.sleep(50);
    }
  } finally {
    await background.stop("shell-smoke-service", true);
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "orchivox-shell-smoke-"));
  try {
    const tool = new PersistentShellTool({ cwd: root, timeoutMs: 5_000 });
    const adapter = tool.shell;
    const windows = isPowerShell(adapter);
    const registry = new ToolRegistry();
    registry.register(tool);
    const request = ChatRequestSchema.parse({
      messages: [{ id: "shell-smoke", role: "user", content: [{ type: "text", text: "Inspect the workspace." }] }],
      tools: registry.listDefinitions(registry.snapshot().values()),
      max_tokens: 100,
    });
    if (adapter.kind === "powershell") {
      check(request.tools[0]?.description.includes("curl.exe"), "PowerShell 5.1 must advertise the native curl executable");
    }

    check(tool.name === "shell", `expected the canonical shell name, got ${tool.name}`);
    check(
      !windows || !adapter.program.toLowerCase().includes("bash"),
      `Windows selected bash instead of PowerShell: ${adapter.program}`,
    );

    const basic = await tool.execute({
      command: windows ? "Write-Output smoke-ok" : "printf smoke-ok",
    });
    check(basic.includes("smoke-ok"), `basic command failed:\n${basic}`);

    const subdir = join(root, "smoke dir");
    await mkdir(subdir, { recursive: true });
    const setup = windows
      ? `Set-Location -LiteralPath ${adapter.quote(subdir)}; $env:ORCHIVOX_SMOKE='smoke-env-ok'`
      : `cd ${adapter.quote(subdir)} && export ORCHIVOX_SMOKE=smoke-env-ok`;
    const setupOutput = await tool.execute({ command: setup });
    check(setupOutput.includes("exit 0"), `cwd/env setup failed:\n${setupOutput}`);

    const persisted = await tool.execute({
      command: windows
        ? "Get-Location; Write-Output $env:ORCHIVOX_SMOKE"
        : 'pwd; printf \'%s\' "$ORCHIVOX_SMOKE"',
    });
    check(persisted.includes("smoke dir"), `cwd did not persist:\n${persisted}`);
    check(persisted.includes("smoke-env-ok"), `environment did not persist:\n${persisted}`);

    const workdir = join(root, "work dir");
    await mkdir(workdir, { recursive: true });
    const explicit = await tool.execute({
      command: windows ? "Get-Location" : "pwd",
      workdir,
    });
    check(explicit.includes("work dir"), `explicit workdir failed:\n${explicit}`);

    let timedOut = false;
    try {
      await tool.execute({
        command: windows ? "Start-Sleep -Seconds 5" : "sleep 5",
        timeoutMs: 500,
      });
    } catch (error) {
      timedOut = error instanceof Error && /timed out/i.test(error.message);
    }
    check(timedOut, "timeout did not kill and report the command");

    const background = new BackgroundProcessManager({ defaultCwd: root });
    const info = await background.start({
      command: windows ? "Write-Output bg-ok" : "printf bg-ok",
      id: "shell-smoke-bg",
      waitForReadyRegex: "bg-ok",
    });
    const logs = background.getLogs(info.id, { lines: 10 });
    await background.stop(info.id, true);
    check(logs.formatted.includes("bg-ok"), `background command failed:\n${logs.formatted}`);

    const hooks = new HookRunner({
      cwd: root,
      hooks: {
        pre_tool_use: [
          {
            match: "*",
            command: windows ? "Write-Output hook-ok" : "printf hook-ok",
            timeout_ms: 5_000,
          },
        ],
        post_tool_use: [],
        on_stop: [],
      },
    });
    const hookOutcome = await hooks.runPreToolUse({ toolName: "shell" });
    check(
      hookOutcome.allowed === true && hookOutcome.notes?.includes("hook-ok"),
      `hook command failed: ${JSON.stringify(hookOutcome)}`,
    );

    const custom = new CustomCommandEngine({ repoRoot: root });
    const expanded = await custom.expandTemplate(
      `value: !\`${windows ? "Write-Output inline-ok" : "printf inline-ok"}\``,
      "",
    );
    check(expanded === "value: inline-ok", `custom command failed: ${expanded}`);

    await checkGitInspection(root);
    await checkLocalService(root, tool);
    console.log(`shell smoke ok: ${adapter.label} (${adapter.program}) on ${process.platform}`);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error: unknown) => {
  console.error("shell smoke failed:", error);
  process.exitCode = 1;
});
