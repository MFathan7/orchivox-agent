import { existsSync } from "node:fs";

export type ShellKind = "bash" | "zsh" | "sh" | "pwsh" | "powershell";

export interface ShellAdapter {
  kind: ShellKind;
  program: string;
  /** Short label for prompts, errors, and stats. */
  label: string;
  /** Build argv for one command in this shell. */
  command(script: string): string[];
  /** Quote one literal value for this shell. */
  quote(value: string): string;
}

export type ShellLookup = (program: string) => boolean;

export interface DetectShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Injectable executable lookup so detection is testable without spawning. */
  exists?: ShellLookup;
}

export type ShellErrorCode =
  | "shell_not_found"
  | "shell_override_invalid"
  | "shell_start_failed"
  | "shell_parse_error"
  | "workdir_not_found"
  | "command_timeout"
  | "command_cancelled";

export class ShellAdapterError extends Error {
  readonly code: "shell_not_found" | "shell_override_invalid";

  constructor(
    code: "shell_not_found" | "shell_override_invalid",
    message: string,
  ) {
    super(message);
    this.name = "ShellAdapterError";
    this.code = code;
  }
}

export class ShellExecutionError extends Error {
  readonly code: ShellErrorCode;

  constructor(code: ShellErrorCode, message: string) {
    super(message);
    this.name = "ShellExecutionError";
    this.code = code;
  }
}

const WINDOWS_PROGRAMS: Array<{ program: string; kind: ShellKind }> = [
  { program: "pwsh.exe", kind: "pwsh" },
  { program: "pwsh", kind: "pwsh" },
  { program: "powershell.exe", kind: "powershell" },
  { program: "powershell", kind: "powershell" },
];

const POSIX_PROGRAMS: Array<{ program: string; kind: ShellKind }> = [
  { program: "bash", kind: "bash" },
  { program: "zsh", kind: "zsh" },
  { program: "sh", kind: "sh" },
];

/**
 * Resolves the shell used by tool execution. This is the Phase 0 contract:
 * detection and command construction are pure enough to test with fake
 * platforms and executable lookups. The shell tool is wired to it in Phase 1.
 */
export function detectShell(options: DetectShellOptions = {}): ShellAdapter {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? ((program: string) => defaultExists(program, env));

  const override = env.ORCHIVOX_SHELL?.trim();
  if (override) {
    const kind = kindFromProgram(override);
    if (!kind) {
      throw new ShellAdapterError(
        "shell_override_invalid",
        `ORCHIVOX_SHELL must name bash, zsh, sh, pwsh, or powershell; got "${override}"`,
      );
    }
    if (!exists(override)) {
      throw new ShellAdapterError(
        "shell_not_found",
        `ORCHIVOX_SHELL points to "${override}", but that executable was not found`,
      );
    }
    return createAdapter(kind, override);
  }

  if (platform === "win32") {
    for (const candidate of WINDOWS_PROGRAMS) {
      if (exists(candidate.program)) return createAdapter(candidate.kind, candidate.program);
    }
    throw new ShellAdapterError(
      "shell_not_found",
      "no PowerShell executable found; install PowerShell 7 (pwsh) or enable Windows PowerShell",
    );
  }

  if (exists("bash")) return createAdapter("bash", "bash");

  const login = env.SHELL?.trim();
  if (login) {
    const kind = kindFromProgram(login);
    if ((kind === "bash" || kind === "zsh") && exists(login)) {
      return createAdapter(kind, login);
    }
  }

  for (const candidate of POSIX_PROGRAMS) {
    if (candidate.kind === "bash") continue;
    if (exists(candidate.program)) return createAdapter(candidate.kind, candidate.program);
  }

  throw new ShellAdapterError(
    "shell_not_found",
    `no supported shell found on ${platform}; install bash, zsh, or sh`,
  );
}

function createAdapter(kind: ShellKind, program: string): ShellAdapter {
  return {
    kind,
    program,
    label: labelFor(kind),
    command(script: string): string[] {
      if (kind === "pwsh" || kind === "powershell") {
        return [program, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
      }
      return [program, "-c", script];
    },
    quote(value: string): string {
      if (kind === "pwsh" || kind === "powershell") {
        return `'${value.replace(/'/g, "''")}'`;
      }
      return `'${value.replace(/'/g, `'\\''`)}'`;
    },
  };
}

function labelFor(kind: ShellKind): string {
  if (kind === "pwsh") return "PowerShell 7 (pwsh)";
  if (kind === "powershell") return "Windows PowerShell 5.1";
  return kind;
}

function kindFromProgram(program: string): ShellKind | undefined {
  const base = program.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (base === "bash" || base === "bash.exe") return "bash";
  if (base === "zsh" || base === "zsh.exe") return "zsh";
  if (base === "sh" || base === "sh.exe") return "sh";
  if (base === "pwsh" || base === "pwsh.exe") return "pwsh";
  if (base === "powershell" || base === "powershell.exe") return "powershell";
  return undefined;
}

function defaultExists(program: string, env: NodeJS.ProcessEnv): boolean {
  if (program.includes("/") || program.includes("\\")) return existsSync(program);
  const pathEntry = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH");
  return Boolean(Bun.which(program, pathEntry ? { PATH: pathEntry[1] ?? "" } : undefined));
}
