import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import packageJson from "../package.json";
import { resolveConfigPaths } from "./config/paths";
import { resolveProjectState } from "./runtime-paths";
import { runGit } from "./vcs/git";

export interface AppInfo {
  version: string;
  commit?: string;
  dirty: boolean;
  entrypoint: "source" | "compiled" | "unknown";
  root: string;
  executable: string;
  bunVersion: string;
  terminal: Record<string, string | undefined>;
}

export interface UpdateOptions {
  check?: boolean;
  binary?: boolean;
}

export interface UpdateResult {
  output: string;
  updated: boolean;
}

function realPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return realpathSync(value);
  } catch {
    return undefined;
  }
}

function installRoot(executable: string): string {
  if (executable.endsWith(join("bin", "orchivox.js")) || executable.endsWith("bin/orchivox.js")) {
    return dirname(dirname(executable));
  }
  if (executable.endsWith(join("src", "index.ts")) || executable.endsWith("src/index.ts")) {
    return dirname(dirname(executable));
  }
  return dirname(executable);
}

function entrypointKind(executable: string): AppInfo["entrypoint"] {
  const name = basename(executable);
  if (name === "orchivox") return "compiled";
  if (name.endsWith(".js") || name.endsWith(".ts")) return "source";
  return "unknown";
}

export async function getAppInfo(): Promise<AppInfo> {
  const script = realPath(process.argv[1]);
  const executable = script ?? realPath(process.execPath) ?? process.execPath;
  const root = installRoot(executable);
  const commit = await runGit(root, ["rev-parse", "--short", "HEAD"], {
    allowFailure: true,
  })
    .then((result) => (result.exitCode === 0 ? result.stdout.trim() : undefined))
    .catch(() => undefined);
  const status = await runGit(root, ["status", "--porcelain"], {
    allowFailure: true,
  })
    .then((result) => result.stdout.trim())
    .catch(() => "");
  return {
    version: packageJson.version,
    commit,
    dirty: status.length > 0,
    entrypoint: entrypointKind(executable),
    root,
    executable,
    bunVersion: Bun.version,
    terminal: {
      TERM: process.env.TERM,
      TERM_PROGRAM: process.env.TERM_PROGRAM,
      KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
      WEZTERM_PANE: process.env.WEZTERM_PANE,
      TMUX: process.env.TMUX,
    },
  };
}

export function formatAppInfo(info: AppInfo): string {
  return [
    `Orchivox ${info.version}`,
    `commit     ${info.commit ?? "unknown"}${info.dirty ? " (dirty)" : ""}`,
    `entrypoint ${info.entrypoint}`,
    `root       ${info.root}`,
    `executable ${info.executable}`,
    `bun        ${info.bunVersion}`,
    `terminal   ${info.terminal.TERM ?? "unknown"}${info.terminal.TMUX ? " (tmux)" : ""}`,
  ].join("\n");
}

async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  const processHandle = Bun.spawn([command, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${exitCode}): ${stderr.trim() || stdout.trim()}`,
    );
  }
  return stdout.trim();
}

export async function runUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const info = await getAppInfo();
  if (info.entrypoint === "compiled") {
    throw new Error(
      "this is a compiled binary; rebuild it with `bun run build:binary` after updating the source checkout",
    );
  }
  const root = info.root;
  const status = await runGit(root, ["status", "--porcelain"], { allowFailure: true });
  if (!options.check && status.stdout.trim().length > 0) {
    throw new Error(
      "working tree is dirty; commit or stash your changes before running `orchivox update`",
    );
  }
  const branch = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"], {
    allowFailure: true,
  }).then((result) => result.stdout.trim());
  if (!branch || branch === "HEAD") {
    throw new Error("cannot update: the checkout is not on a branch");
  }
  await runGit(root, ["fetch", "--prune", "origin"], { allowFailure: false });
  const upstream = await runGit(
    root,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { allowFailure: true },
  ).then((result) => result.stdout.trim() || `origin/${branch}`);
  const behind = await runGit(root, ["rev-list", "--count", `HEAD..${upstream}`], {
    allowFailure: true,
  }).then((result) => Number.parseInt(result.stdout.trim(), 10) || 0);
  const ahead = await runGit(root, ["rev-list", "--count", `${upstream}..HEAD`], {
    allowFailure: true,
  }).then((result) => Number.parseInt(result.stdout.trim(), 10) || 0);

  if (behind === 0) {
    return {
      output: `already up to date on ${branch} (${info.commit ?? "unknown"})${ahead > 0 ? `, ${ahead} local commit(s) ahead` : ""}`,
      updated: false,
    };
  }
  if (options.check) {
    return {
      output: `${behind} commit(s) available on ${upstream}${ahead > 0 ? `, ${ahead} local commit(s) ahead` : ""}. Run \`orchivox update\` to apply them.`,
      updated: false,
    };
  }

  const before = info.commit ?? "unknown";
  await runGit(root, ["pull", "--ff-only"], { allowFailure: false });
  const install = await runCommand("bun", ["install", "--frozen-lockfile"], root);
  if (options.binary) {
    await runCommand("bun", ["run", "build:binary"], root);
  }
  const after = await runGit(root, ["rev-parse", "--short", "HEAD"], {
    allowFailure: true,
  }).then((result) => result.stdout.trim());
  return {
    output: [
      `updated ${branch}: ${before} -> ${after || "unknown"}`,
      install,
      options.binary ? "compiled binary rebuilt" : "source checkout updated",
      "restart Orchivox to use the new version",
    ]
      .filter(Boolean)
      .join("\n"),
    updated: true,
  };
}

export async function formatDoctor(cwd = process.cwd()): Promise<string> {
  const info = await getAppInfo();
  const paths = await resolveConfigPaths({ cwd }).catch(() => undefined);
  const lines = [
    formatAppInfo(info),
    `cwd        ${cwd}`,
    `config     ${paths?.configPath ?? "unknown"} (${paths?.configSource ?? "unknown"})`,
    `secrets    ${paths?.secretsPath ?? "unknown"} (${paths?.secretsSource ?? "unknown"})`,
    `project    ${existsSync(join(cwd, ".agent", "config.yaml")) ? "found" : "not found"}`,
    `global     ${existsSync(join(process.env.HOME ?? "", ".orchivox", "config.yaml")) ? "found" : "not found"}`,
    `state      ${resolveProjectState(cwd).dataDir}`,
    `database   ${resolveProjectState(cwd).memoryDb}`,
    `legacy     ${
      existsSync(join(cwd, ".agent", "memory.db")) ||
      existsSync(join(cwd, ".agent", "history.json")) ||
      existsSync(join(cwd, ".agent", "snapshots"))
        ? "project .agent state found; it is no longer written by Orchivox"
        : "none"
    }`,
    `input debug set ORCHIVOX_INPUT_DEBUG=1 and restart to log raw key sequences`,
  ];
  return lines.join("\n");
}
