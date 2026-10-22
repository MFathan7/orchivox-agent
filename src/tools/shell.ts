import { z } from "zod";

import { DEFAULT_MAX_BYTES, spillToolOutput, truncateTail } from "./output-budget";
import type { AgentTool } from "./registry";

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

export class PersistentShellTool implements AgentTool<typeof ShellArgsSchema> {
  readonly name = "bash";
  readonly description =
    "Run a bash command. The working directory and exported environment variables persist between calls.";
  readonly parameters = ShellArgsSchema;
  readonly readOnly = false;

  private currentDir: string;
  private currentEnv: Record<string, string>;
  private readonly defaultTimeoutMs: number;
  private readonly interceptor: CommandInterceptor | undefined;

  constructor(options: PersistentShellToolOptions = {}) {
    this.currentDir = options.cwd ?? process.cwd();
    this.currentEnv = { ...collectEnv(), ...options.env };
    this.defaultTimeoutMs = options.timeoutMs ?? 60_000;
    this.interceptor = options.interceptor;
  }

  get workingDirectory(): string {
    return this.currentDir;
  }

  get environment(): Record<string, string> {
    return { ...this.currentEnv };
  }

  async execute(args: ShellArgs): Promise<string> {
    if (this.interceptor) {
      const decision = await this.interceptor(args.command);
      if (!decision.allowed) {
        throw new Error(`command blocked: ${decision.reason ?? "rejected by the command interceptor"}`);
      }
    }
    return this.runBash(args.command, args.timeoutMs ?? this.defaultTimeoutMs);
  }

  private async runBash(command: string, timeoutMs: number): Promise<string> {
    const metaPath = `${globalThis.process.env.TMPDIR ?? "/tmp"}/orchivox-shell-${crypto.randomUUID()}.meta`;
    const script = [
      `cd ${shellQuote(this.currentDir)} || exit 97`,
      command,
      `__orchivox_exit=$?`,
      `{ printf '%s\\0' "$__orchivox_exit" "$PWD"; env -0; } > ${shellQuote(metaPath)}`,
      `exit $__orchivox_exit`,
    ].join("\n");

    const proc = Bun.spawn(["bash", "-c", script], {
      cwd: this.currentDir,
      env: this.currentEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const kill = (): void => proc.kill();
    timeoutSignal.addEventListener("abort", kill, { once: true });

    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    timeoutSignal.removeEventListener("abort", kill);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

    const meta = await readAndClearMeta(metaPath);
    if (meta) {
      this.currentDir = meta.pwd;
      this.currentEnv = meta.env;
    }

    if (timeoutSignal.aborted) {
      throw new Error(
        `command timed out after ${timeoutMs}ms and was killed\n${
          truncateTail(`--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`).text
        }`,
      );
    }

    const full = `exit ${exitCode}\n--- stdout ---\n${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`;
    if (Buffer.byteLength(full, "utf8") <= DEFAULT_MAX_BYTES) return full;
    const logPath = await spillToolOutput(full, "bash");
    return truncateTail(full, {
      detail: logPath ? `Full output: ${logPath}` : "",
    }).text;
  }
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
  if (!(await file.exists())) return undefined;
  const raw = await file.text();
  await file.delete();
  const parts = raw.split("\0");
  if (parts.length < 2) return undefined;
  const env: Record<string, string> = {};
  for (const entry of parts.slice(2)) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator > 0) env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return { pwd: parts[1], env };
}
