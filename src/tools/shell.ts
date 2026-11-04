import { closeSync, openSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import { currentTurnContext } from "../agent/turn-context";
import { ensureRuntimeTempDir } from "../runtime-temp";
import { DEFAULT_MAX_BYTES, spillToolOutput, truncateTail } from "./output-budget";
import { killProcessTree } from "./process-tree";
import type { AgentTool, ToolExecutionContext } from "./registry";
import {
  detectShell,
  ShellAdapterError,
  ShellExecutionError,
  type ShellAdapter,
} from "./shell-adapter";

export interface CommandCheck {
  allowed: boolean;
  reason?: string;
}

export type CommandInterceptor = (command: string) => CommandCheck | Promise<CommandCheck>;

export interface PersistentShellToolOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  interceptor?: CommandInterceptor;
  /** Tool name shown to the model. Defaults to the canonical "shell". */
  name?: string;
  /** Injectable adapter for tests. */
  adapter?: ShellAdapter;
}

export const ShellArgsSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  /** Working directory for this call, relative to the current shell directory. */
  workdir: z.string().min(1).optional(),
});
export type ShellArgs = z.infer<typeof ShellArgsSchema>;

/** Keep the per-workspace shell map bounded when many workers run over a session. */
const MAX_SHELL_WORKSPACES = 64;

interface ShellState {
  dir: string;
  env: Record<string, string>;
}

export interface ShellMeta {
  pwd?: string;
  env: Record<string, string>;
  envCaptured: boolean;
}

export class PersistentShellTool implements AgentTool<typeof ShellArgsSchema> {
  readonly name: string;
  readonly description =
    "Run a shell command. The working directory and exported environment persist between calls. Use workdir instead of cd. For a dev server or long-running process, use bg_start. Use curl --max-time or --connect-timeout for HTTP probes.";
  readonly parameters = ShellArgsSchema;
  readonly readOnly = false;

  private readonly defaultDir: string;
  private readonly baseEnv: Record<string, string>;
  private readonly inheritedTmpDir: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly interceptor: CommandInterceptor | undefined;
  private adapter: ShellAdapter | undefined;
  /** One persistent shell per workspace, so parallel workers keep separate cwd and env. */
  private readonly states = new Map<string, ShellState>();

  constructor(options: PersistentShellToolOptions = {}) {
    this.name = options.name ?? "shell";
    this.defaultDir = options.cwd ?? process.cwd();
    this.baseEnv = { ...collectEnv(), ...options.env };
    this.inheritedTmpDir = globalThis.process.env.TMPDIR;
    this.defaultTimeoutMs = options.timeoutMs ?? 60_000;
    this.interceptor = options.interceptor;
    this.adapter = options.adapter;
  }

  get workingDirectory(): string {
    return this.stateFor(this.defaultDir).dir;
  }

  get environment(): Record<string, string> {
    return { ...this.stateFor(this.defaultDir).env };
  }

  get shell(): ShellAdapter {
    return this.resolveAdapter();
  }

  async execute(args: ShellArgs, context?: ToolExecutionContext): Promise<string> {
    if (this.interceptor) {
      const decision = await this.interceptor(args.command);
      if (!decision.allowed) {
        throw new Error(`command blocked: ${decision.reason ?? "rejected by the command interceptor"}`);
      }
    }
    const root = currentTurnContext()?.workspaceRoot ?? this.defaultDir;
    const state = this.stateFor(root);
    const adapter = this.resolveAdapter();
    const workdir = args.workdir ? resolve(state.dir, args.workdir) : state.dir;
    assertWorkdir(workdir);
    return this.runCommand(
      args.command,
      args.timeoutMs ?? this.defaultTimeoutMs,
      state,
      workdir,
      adapter,
      context?.signal,
    );
  }

  private resolveAdapter(): ShellAdapter {
    if (this.adapter) return this.adapter;
    try {
      this.adapter = detectShell({ env: this.baseEnv });
      return this.adapter;
    } catch (error) {
      if (error instanceof ShellAdapterError) {
        throw new ShellExecutionError(error.code, error.message);
      }
      throw error;
    }
  }

  private stateFor(root: string): ShellState {
    const existing = this.states.get(root);
    if (existing) return existing;
    const state: ShellState = { dir: root, env: { ...this.baseEnv } };
    this.states.set(root, state);
    if (this.states.size > MAX_SHELL_WORKSPACES) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined && oldest !== root) this.states.delete(oldest);
    }
    return state;
  }

  private async runCommand(
    command: string,
    timeoutMs: number,
    state: ShellState,
    workdir: string,
    adapter: ShellAdapter,
    signal?: AbortSignal,
  ): Promise<string> {
    const tempDir = await ensureRuntimeTempDir(this.defaultDir).catch(
      () => this.inheritedTmpDir ?? "/tmp",
    );
    if (state.env.TMPDIR === undefined || state.env.TMPDIR === this.inheritedTmpDir) {
      state.env.TMPDIR = tempDir;
    }
    const nonce = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const metaPath = join(tempDir, `shell-${nonce}.meta`);
    const stdoutPath = join(tempDir, `shell-${nonce}.stdout`);
    const stderrPath = join(tempDir, `shell-${nonce}.stderr`);
    const script = isPowerShell(adapter)
      ? buildPowerShellScript(command, workdir, metaPath, adapter)
      : buildPosixScript(command, workdir, metaPath, adapter);

    const stdoutFd = openSync(stdoutPath, "w");
    let stderrFd: number;
    try {
      stderrFd = openSync(stderrPath, "w");
    } catch (error) {
      closeSync(stdoutFd);
      await removeOutputFile(stdoutPath);
      throw error;
    }

    const [program, ...programArgs] = adapter.command(script);
    const spawn = () =>
      Bun.spawn([program, ...programArgs], {
        cwd: workdir,
        env: state.env,
        stdin: "ignore",
        stdout: stdoutFd,
        stderr: stderrFd,
        detached: process.platform !== "win32",
      });

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn();
    } catch (error) {
      await Promise.all([removeOutputFile(stdoutPath), removeOutputFile(stderrPath)]);
      throw new ShellExecutionError(
        "shell_start_failed",
        `shell_start_failed: could not start ${adapter.label}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }

    let timedOut = false;
    let aborted = signal?.aborted ?? false;
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      killProcessTree(proc, { force: true });
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killProcessTree(proc, { force: true });
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      exitCode = await proc.exited;
      settled = true;
      stdout = await readOutputFile(stdoutPath);
      stderr = await readOutputFile(stderrPath);
    } finally {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
      await Promise.all([removeOutputFile(stdoutPath), removeOutputFile(stderrPath)]);
    }

    const meta = await readAndClearMeta(metaPath, adapter);
    if (meta) {
      if (meta.pwd) state.dir = meta.pwd;
      if (meta.envCaptured) state.env = meta.env;
    }

    const captured = `--- stdout ---\n${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`;
    if (aborted) {
      throw new ShellExecutionError(
        "command_cancelled",
        `Command cancelled\n${truncateTail(captured).text}`,
      );
    }
    if (timedOut) {
      throw new ShellExecutionError(
        "command_timeout",
        `command timed out after ${timeoutMs}ms and was killed\n${truncateTail(captured).text}`,
      );
    }

    const backgroundNote = hasBackgroundChild(command)
      ? "\n\n[shell exited; background children may still be running]"
      : "";
    const full = `exit ${exitCode}\n${captured}${backgroundNote}`;
    if (Buffer.byteLength(full, "utf8") <= DEFAULT_MAX_BYTES) return full;
    const logPath = await spillToolOutput(full, "shell");
    return truncateTail(full, {
      detail: logPath ? `Full output: ${logPath}` : "",
    }).text;
  }
}

function isPowerShell(adapter: ShellAdapter): boolean {
  return adapter.kind === "pwsh" || adapter.kind === "powershell";
}

export function buildPosixScript(
  command: string,
  workdir: string,
  metaPath: string,
  adapter: ShellAdapter,
): string {
  const quote = (value: string): string => adapter.quote(value);
  const capture =
    adapter.kind === "bash"
      ? [
          `{ printf '%s\\0' "$__orchivox_exit" "$PWD" "nul";`,
          `  for __orchivox_name in $(compgen -e); do`,
          `    case "$__orchivox_name" in`,
          `      [A-Za-z_]*) printf '%s\\0' "$__orchivox_name=\${!__orchivox_name}" ;;`,
          `    esac`,
          `  done`,
          `} > ${quote(metaPath)}`,
        ].join("\n")
      : [`{ printf '%s\\0' "$__orchivox_exit" "$PWD" "lines"; env; } > ${quote(metaPath)}`].join(
          "\n",
        );
  return [
    `cd ${quote(workdir)} || exit 97`,
    command,
    `__orchivox_exit=$?`,
    capture,
    `exit $__orchivox_exit`,
  ].join("\n");
}

export function buildPowerShellScript(
  command: string,
  workdir: string,
  metaPath: string,
  adapter: ShellAdapter,
): string {
  const quote = (value: string): string => adapter.quote(value);
  return [
    `$ErrorActionPreference = 'Continue'`,
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`,
    `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)`,
    `Set-Location -LiteralPath ${quote(workdir)}`,
    `$global:LASTEXITCODE = 0`,
    `try {`,
    command,
    `  if ($LASTEXITCODE -ne 0) { $__orchivox_exit = $LASTEXITCODE } elseif ($?) { $__orchivox_exit = 0 } else { $__orchivox_exit = 1 }`,
    `} catch {`,
    `  Write-Error $_`,
    `  $__orchivox_exit = 1`,
    `}`,
    `$__orchivox_env = @{}`,
    `Get-ChildItem Env: | ForEach-Object { $__orchivox_env[$_.Name] = $_.Value }`,
    `$__orchivox_json = [ordered]@{ exit = $__orchivox_exit; pwd = (Get-Location).Path; env = $__orchivox_env } | ConvertTo-Json -Compress -Depth 4`,
    `[System.IO.File]::WriteAllText(${quote(metaPath)}, $__orchivox_json, [System.Text.UTF8Encoding]::new($false))`,
    `exit $__orchivox_exit`,
  ].join("\n");
}

function assertWorkdir(path: string): void {
  try {
    if (!statSync(path).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new ShellExecutionError(
      "workdir_not_found",
      `workdir_not_found: ${path} is not a directory`,
    );
  }
}

function hasBackgroundChild(command: string): boolean {
  return /(^|[^&<>])&(?!&)/m.test(command);
}

async function readOutputFile(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "";
  }
}

async function removeOutputFile(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

function collectEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(globalThis.process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function readAndClearMeta(
  metaPath: string,
  adapter: ShellAdapter,
): Promise<ShellMeta | undefined> {
  const file = Bun.file(metaPath);
  try {
    if (!(await file.exists())) return undefined;
    const raw = await file.text();
    if (isPowerShell(adapter)) {
      return parsePowerShellMeta(raw);
    }
    return parsePosixMeta(raw);
  } catch {
    return undefined;
  } finally {
    await file.delete().catch(() => undefined);
  }
}

function parsePosixMeta(raw: string): ShellMeta | undefined {
  const parts = raw.split("\0");
  if (parts.length < 3) return undefined;
  const pwd = parts[1] || undefined;
  const format = parts[2];
  const entries =
    format === "nul"
      ? parts.slice(3)
      : parseEnvLines(parts.slice(3).join("\0"));
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator > 0) env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return { pwd, env, envCaptured: envEntriesPresent(format, entries) };
}

function envEntriesPresent(format: string, entries: string[]): boolean {
  if (format === "nul") return entries.some((entry) => entry.length > 0);
  return entries.length > 0;
}

function parseEnvLines(raw: string): string[] {
  if (raw.length === 0) return [];
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const entries: string[] = [];
  let current: string | undefined;
  for (const line of normalized.split("\n")) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) {
      if (current !== undefined) entries.push(current);
      current = line;
    } else if (current !== undefined) {
      current += `\n${line}`;
    }
  }
  if (current !== undefined) entries.push(current);
  return entries;
}

export function parsePowerShellMeta(raw: string): ShellMeta | undefined {
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as {
      pwd?: unknown;
      env?: unknown;
    };
    const env: Record<string, string> = {};
    if (parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)) {
      for (const [key, value] of Object.entries(parsed.env)) {
        if (typeof value === "string") env[key] = value;
      }
    }
    return {
      pwd: typeof parsed.pwd === "string" ? parsed.pwd : undefined,
      env,
      envCaptured: Object.keys(env).length > 0,
    };
  } catch {
    return undefined;
  }
}
