import { closeSync, openSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { currentTurnContext } from "../agent/turn-context";
import { ensureRuntimeTempDir } from "../runtime-temp";
import { DEFAULT_MAX_BYTES, spillToolOutput, truncateTail } from "./output-budget";
import type { AgentTool, ToolExecutionContext } from "./registry";

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
}

export const ShellArgsSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});
export type ShellArgs = z.infer<typeof ShellArgsSchema>;

/** Keep the per-workspace shell map bounded when many workers run over a session. */
const MAX_SHELL_WORKSPACES = 64;

interface ShellState {
  dir: string;
  env: Record<string, string>;
}

export class PersistentShellTool implements AgentTool<typeof ShellArgsSchema> {
  readonly name = "bash";
  readonly description =
    "Run a bash command. The working directory and exported environment variables persist between calls. For a dev server or another long-running process, use bg_start instead of backgrounding the command with &. Use curl --max-time or --connect-timeout for HTTP probes.";
  readonly parameters = ShellArgsSchema;
  readonly readOnly = false;

  private readonly defaultDir: string;
  private readonly baseEnv: Record<string, string>;
  private readonly inheritedTmpDir: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly interceptor: CommandInterceptor | undefined;
  /** One persistent shell per workspace, so parallel workers keep separate cwd and env. */
  private readonly states = new Map<string, ShellState>();

  constructor(options: PersistentShellToolOptions = {}) {
    this.defaultDir = options.cwd ?? process.cwd();
    this.baseEnv = { ...collectEnv(), ...options.env };
    this.inheritedTmpDir = globalThis.process.env.TMPDIR;
    this.defaultTimeoutMs = options.timeoutMs ?? 60_000;
    this.interceptor = options.interceptor;
  }

  get workingDirectory(): string {
    return this.stateFor(this.defaultDir).dir;
  }

  get environment(): Record<string, string> {
    return { ...this.stateFor(this.defaultDir).env };
  }

  async execute(args: ShellArgs, context?: ToolExecutionContext): Promise<string> {
    if (this.interceptor) {
      const decision = await this.interceptor(args.command);
      if (!decision.allowed) {
        throw new Error(`command blocked: ${decision.reason ?? "rejected by the command interceptor"}`);
      }
    }
    const root = currentTurnContext()?.workspaceRoot ?? this.defaultDir;
    return this.runBash(
      args.command,
      args.timeoutMs ?? this.defaultTimeoutMs,
      this.stateFor(root),
      context?.signal,
    );
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

  private async runBash(
    command: string,
    timeoutMs: number,
    state: ShellState,
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
    const script = [
      `cd ${shellQuote(state.dir)} || exit 97`,
      command,
      `__orchivox_exit=$?`,
      `{ printf '%s\\0' "$__orchivox_exit" "$PWD"; env -0; } > ${shellQuote(metaPath)}`,
      `exit $__orchivox_exit`,
    ].join("\n");

    const stdoutFd = openSync(stdoutPath, "w");
    let stderrFd: number;
    try {
      stderrFd = openSync(stderrPath, "w");
    } catch (error) {
      closeSync(stdoutFd);
      await removeOutputFile(stdoutPath);
      throw error;
    }

    const spawn = () =>
      Bun.spawn(["bash", "-c", script], {
        cwd: state.dir,
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
      throw error;
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
      killProcessTree(proc);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killProcessTree(proc);
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

    const meta = await readAndClearMeta(metaPath);
    if (meta) {
      state.dir = meta.pwd;
      state.env = meta.env;
    }

    const captured = `--- stdout ---\n${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`;
    if (aborted) {
      throw new Error(`Command cancelled\n${truncateTail(captured).text}`);
    }
    if (timedOut) {
      throw new Error(
        `command timed out after ${timeoutMs}ms and was killed\n${truncateTail(captured).text}`,
      );
    }

    const backgroundNote = hasBackgroundChild(command)
      ? "\n\n[shell exited; background children may still be running]"
      : "";
    const full = `exit ${exitCode}\n${captured}${backgroundNote}`;
    if (Buffer.byteLength(full, "utf8") <= DEFAULT_MAX_BYTES) return full;
    const logPath = await spillToolOutput(full, "bash");
    return truncateTail(full, {
      detail: logPath ? `Full output: ${logPath}` : "",
    }).text;
  }
}

function killProcessTree(proc: ReturnType<typeof Bun.spawn>): void {
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(proc.pid)]);
    } catch {
      // Fall back to the shell process itself.
    }
    try {
      proc.kill();
    } catch {
      // The process already exited.
    }
    return;
  }
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill();
    } catch {
      // The process already exited.
    }
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface ShellMeta {
  pwd: string;
  env: Record<string, string>;
}

async function readAndClearMeta(metaPath: string): Promise<ShellMeta | undefined> {
  const file = Bun.file(metaPath);
  try {
    if (!(await file.exists())) return undefined;
    const raw = await file.text();
    const parts = raw.split("\0");
    if (parts.length < 2) return undefined;
    const env: Record<string, string> = {};
    for (const entry of parts.slice(2)) {
      if (!entry) continue;
      const separator = entry.indexOf("=");
      if (separator > 0) env[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
    return { pwd: parts[1], env };
  } catch {
    return undefined;
  } finally {
    await file.delete().catch(() => undefined);
  }
}
