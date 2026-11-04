#!/usr/bin/env bun
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CustomCommandEngine } from "../src/agent/custom-commands";
import { HookRunner } from "../src/agent/hooks";
import { BackgroundProcessManager } from "../src/tools/bg-process";
import { PersistentShellTool } from "../src/tools/shell";
import type { ShellAdapter } from "../src/tools/shell-adapter";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isPowerShell(adapter: ShellAdapter): boolean {
  return adapter.kind === "pwsh" || adapter.kind === "powershell";
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "orchivox-shell-smoke-"));
  try {
    const tool = new PersistentShellTool({ cwd: root, timeoutMs: 5_000 });
    const adapter = tool.shell;
    const windows = isPowerShell(adapter);

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
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
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

    console.log(`shell smoke ok: ${adapter.label} (${adapter.program}) on ${process.platform}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error("shell smoke failed:", error);
  process.exitCode = 1;
});
