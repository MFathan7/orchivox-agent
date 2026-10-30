import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

import packageJson from "../package.json";
import { resolveConfigPaths } from "./config/paths";
import { InstallerError, type InstallMethod } from "./installer/types";
import {
  applyUpdate,
  checkUpdate,
  fetchUpdateCheck,
  formatUpdateCheck,
  rollbackUpdate,
} from "./installer/update";
import { createInstallerUI, formatBytes } from "./installer/ui";
import { assetForPlatform, fetchSignedManifest } from "./installer/manifest";
import { currentPlatform, platformLabel } from "./installer/platform";
import { migrateLegacyInstall, readInstallRecord, resolveInstallPaths } from "./installer/paths";
import { resolveProjectState } from "./runtime-paths";
import { runGit } from "./vcs/git";

export interface AppInfo {
  version: string;
  commit?: string;
  dirty: boolean;
  entrypoint: "source" | "compiled" | "unknown";
  installMethod: InstallMethod | "unknown";
  installDir: string;
  channel: string;
  previousVersion?: string;
  root: string;
  executable: string;
  bunVersion: string;
  terminal: Record<string, string | undefined>;
}

export interface UpdateOptions {
  check?: boolean;
  binary?: boolean;
  yes?: boolean;
  rollback?: boolean;
  source?: boolean;
  json?: boolean;
  timeoutMs?: number;
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

const SOURCE_PACKAGE_NAMES = new Set(["orchivox", "orchivox-agent"]);

function isSourceCheckout(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  if (!existsSync(join(dir, "scripts", "install-global.ts"))) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
    return typeof pkg.name === "string" && SOURCE_PACKAGE_NAMES.has(pkg.name);
  } catch {
    return false;
  }
}

export function findSourceCheckout(
  cwd = process.cwd(),
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  let current = cwd;
  while (true) {
    if (isSourceCheckout(current)) return current;
    const parent = dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }

  const sourceRecordPaths = [
    join(home, ".orchivox", "install_source.json"),
    env.ORCHIVOX_INSTALL_DIR
      ? join(env.ORCHIVOX_INSTALL_DIR, "install_source.json")
      : undefined,
  ].filter((value): value is string => Boolean(value));

  for (const sourceRecordPath of sourceRecordPaths) {
    if (!existsSync(sourceRecordPath)) continue;
    try {
      const data = JSON.parse(readFileSync(sourceRecordPath, "utf8")) as {
        sourceDir?: unknown;
      };
      if (typeof data.sourceDir === "string" && isSourceCheckout(data.sourceDir)) {
        return data.sourceDir;
      }
    } catch {
      // ignore
    }
  }

  const managedSrc = join(home, ".orchivox", "src");
  if (isSourceCheckout(managedSrc)) return managedSrc;

  return undefined;
}

export async function getAppInfo(): Promise<AppInfo> {
  const script = realPath(process.argv[1]);
  const executable = script ?? realPath(process.execPath) ?? process.execPath;
  const kind = entrypointKind(executable);
  const paths = resolveInstallPaths();
  const record = migrateLegacyInstall(paths);
  const sourceDir = findSourceCheckout();
  const installMethod: InstallMethod | "unknown" =
    record?.method ??
    (kind === "source" ? "source" : sourceDir && kind === "compiled" ? "source" : "unknown");
  const root =
    installMethod === "source"
      ? sourceDir ?? installRoot(executable)
      : record
        ? paths.baseDir
        : installRoot(executable);
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
    version: record?.version ?? packageJson.version,
    commit,
    dirty: status.length > 0,
    entrypoint: kind,
    installMethod,
    installDir: paths.baseDir,
    channel: record?.channel ?? "stable",
    previousVersion: record?.previous,
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
    `install    ${info.installMethod} (${info.installDir})`,
    `channel    ${info.channel}`,
    ...(info.previousVersion ? [`previous   ${info.previousVersion}`] : []),
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

function readPackageVersion(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export async function runUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const info = await getAppInfo();
  if (options.rollback) {
    if (info.installMethod === "source") {
      throw new Error("rollback is only available for managed binary installs");
    }
    return runManagedRollback(options);
  }
  if (options.source || info.installMethod === "source") {
    return runSourceUpdate(info, options);
  }
  return runManagedUpdate(info, options);
}

async function runManagedUpdate(
  info: AppInfo,
  options: UpdateOptions,
): Promise<UpdateResult> {
  const paths = resolveInstallPaths();
  const current = readInstallRecord(paths)?.version ?? info.version;
  const platform = currentPlatform();
  let manifest;
  try {
    manifest = await fetchSignedManifest({
      timeoutMs: options.timeoutMs ?? 30_000,
    });
  } catch (error) {
    throw new Error(
      `update check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const check = checkUpdate(manifest, current);
  if (options.check) {
    if (options.json) {
      return {
        output: JSON.stringify(
          { method: "standalone", ...check },
          null,
          2,
        ),
        updated: false,
      };
    }
    return {
      output: `${formatUpdateCheck(check)}\n${check.notes_url}`,
      updated: false,
    };
  }

  if (!check.available) {
    if (options.json) {
      return {
        output: JSON.stringify({ method: "standalone", ...check, updated: false }, null, 2),
        updated: false,
      };
    }
    return { output: formatUpdateCheck(check), updated: false };
  }

  if (options.json && !options.yes) {
    throw new Error("--json for update requires --yes");
  }
  if (!options.yes && !process.stdin.isTTY) {
    throw new Error("update requires --yes in non-interactive mode");
  }

  const asset = assetForPlatform(manifest, platform);
  if (options.json) {
    const result = await applyUpdate({
      manifest,
      currentVersion: current,
      platform,
      paths,
      launcherVersion: packageJson.version,
    });
    return {
      output: JSON.stringify(
        { method: "standalone", from: current, to: result.version, updated: true },
        null,
        2,
      ),
      updated: true,
    };
  }

  const ui = createInstallerUI({ env: process.env });
  try {
    await ui.banner(current, platformLabel(platform));
    ui.info(`Update available: ${current} -> ${manifest.version}`);
    ui.info(`Channel: ${manifest.channel}`);
    ui.info(`Download: ${formatBytes(asset.size)}`);
    const approved = options.yes
      ? true
      : await ui.confirm(`Update Orchivox to ${manifest.version}?`, false);
    if (!approved) {
      return { output: "Update cancelled.", updated: false };
    }

    ui.startSteps(
      [
        { id: "detect", label: "Detect platform", detail: platformLabel(platform) },
        {
          id: "resolve",
          label: "Resolve release",
          detail: `${manifest.version} ${manifest.channel}`,
        },
        { id: "download", label: "Download" },
        { id: "verify", label: "Verify SHA-256" },
        { id: "install", label: "Install" },
        { id: "link", label: "Link command" },
      ],
      ["detect", "resolve"],
    );

    const result = await applyUpdate({
      manifest,
      currentVersion: current,
      platform,
      paths,
      launcherVersion: packageJson.version,
      onProgress: (progress) => ui.progress(progress),
      onStage(stage) {
        if (stage === "download") ui.stage("download", formatBytes(asset.size));
        else if (stage === "verify") {
          ui.completeStep("download", formatBytes(asset.size));
          ui.stage("verify", "SHA-256");
        } else if (stage === "install") ui.stage("install", `v${manifest.version}`);
        else if (stage === "link") ui.stage("link", paths.binaryPath);
      },
    });
    ui.finishSteps();
    return {
      output: `Updated Orchivox ${current} -> ${result.version}. Restart Orchivox to use the new version.`,
      updated: true,
    };
  } catch (error) {
    if (!(error instanceof InstallerError && error.code === "cancelled")) {
      ui.failActive(error instanceof Error ? error.message : String(error));
    }
    throw error;
  } finally {
    ui.close();
  }
}

async function runManagedRollback(options: UpdateOptions): Promise<UpdateResult> {
  const paths = resolveInstallPaths();
  const record = await rollbackUpdate({ paths });
  if (options.json) {
    return {
      output: JSON.stringify(
        { method: "standalone", version: record.version, previous: record.previous, updated: true },
        null,
        2,
      ),
      updated: true,
    };
  }
  return {
    output: `Rolled back to Orchivox ${record.version}. Restart Orchivox to use the previous version.`,
    updated: true,
  };
}

async function runSourceUpdate(
  info: AppInfo,
  options: UpdateOptions,
): Promise<UpdateResult> {
  const root = options.source ? findSourceCheckout() ?? info.root : info.root;
  const gitCheck = await runGit(root, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  if (gitCheck.exitCode !== 0) {
    throw new Error(
      "No Orchivox source repository found on this system.\n" +
      "To enable source updates, clone Orchivox into your preferred folder or ~/.orchivox/src:\n" +
      "  git clone https://github.com/MFathan7/orchivox-agent.git ~/.orchivox/src\n" +
      "  cd ~/.orchivox/src && bun install && bun run install:global",
    );
  }

  const status = await runGit(root, ["status", "--porcelain"], { allowFailure: true });
  if (!options.check && status.stdout.trim().length > 0) {
    throw new Error(
      `working tree at ${root} is dirty; commit or stash your changes before running \`orchivox update\``,
    );
  }
  const branch = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"], {
    allowFailure: true,
  }).then((result) => result.stdout.trim());
  if (!branch || branch === "HEAD") {
    throw new Error(`cannot update: the checkout at ${root} is not on a branch`);
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
  const currentCommit = await runGit(root, ["rev-parse", "--short", "HEAD"], {
    allowFailure: true,
  })
    .then((result) => result.stdout.trim())
    .catch(() => info.commit ?? "unknown");

  const sourceVersion = readPackageVersion(root);
  const runningVersion = packageJson.version;
  const staleBinary =
    info.entrypoint === "compiled" &&
    typeof sourceVersion === "string" &&
    sourceVersion !== runningVersion;
  const available = behind > 0 || staleBinary;

  if (!available) {
    const output = `already up to date on ${branch} (${currentCommit})${ahead > 0 ? `, ${ahead} local commit(s) ahead` : ""}`;
    return {
      output: options.json
        ? JSON.stringify({ method: "source", branch, commit: currentCommit, behind, ahead, updated: false }, null, 2)
        : output,
      updated: false,
    };
  }
  if (options.check) {
    const reasons: string[] = [];
    if (behind > 0) reasons.push(`${behind} commit(s) available on ${upstream}`);
    if (staleBinary) {
      reasons.push(
        `installed binary is ${runningVersion} while the checkout is ${sourceVersion}`,
      );
    }
    const output = `${reasons.join("; ")}${ahead > 0 ? `, ${ahead} local commit(s) ahead` : ""}. Run \`orchivox update\` to apply.`;
    return {
      output: options.json
        ? JSON.stringify(
            {
              method: "source",
              branch,
              upstream,
              behind,
              ahead,
              sourceVersion,
              runningVersion,
              staleBinary,
              updated: false,
            },
            null,
            2,
          )
        : output,
      updated: false,
    };
  }

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      throw new Error("source update requires --yes in non-interactive mode");
    }
    const approved = await promptYesNo(
      behind > 0
        ? `Update source checkout at ${root}?`
        : `Rebuild the installed binary from ${root}?`,
      false,
    );
    if (!approved) {
      return { output: "Update cancelled.", updated: false };
    }
  }

  const before = currentCommit;
  if (behind > 0) {
    await runGit(root, ["pull", "--ff-only"], { allowFailure: false });
  }
  let installOutput = "";
  try {
    installOutput = await runCommand("bun", ["install", "--frozen-lockfile"], root);
  } catch {
    installOutput = await runCommand("bun", ["install"], root);
  }

  let rebuilt = false;
  if (info.entrypoint === "compiled" || options.binary || staleBinary) {
    await runCommand("bun", ["run", "scripts/install-global.ts"], root);
    rebuilt = true;
  }
  const after = await runGit(root, ["rev-parse", "--short", "HEAD"], {
    allowFailure: true,
  }).then((result) => result.stdout.trim());

  if (options.json) {
    return {
      output: JSON.stringify(
        { method: "source", branch, from: before, to: after, rebuilt, staleBinary, updated: true },
        null,
        2,
      ),
      updated: true,
    };
  }
  return {
    output: [
      behind > 0
        ? `updated ${branch}: ${before} -> ${after || "unknown"}`
        : `source checkout already at ${branch} (${currentCommit})`,
      installOutput,
      rebuilt
        ? "standalone binary rebuilt and reinstalled to ~/.local/bin/orchivox"
        : "source checkout updated",
      "restart Orchivox to use the new version",
    ]
      .filter(Boolean)
      .join("\n"),
    updated: true,
  };
}

async function promptYesNo(question: string, defaultValue: boolean): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? "[Y/n]" : "[y/N]";
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (answer === "") return defaultValue;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    return defaultValue;
  } finally {
    rl.close();
  }
}

export async function formatDoctor(
  cwd = process.cwd(),
  options: { checkUpdates?: boolean } = {},
): Promise<string> {
  const info = await getAppInfo();
  const paths = await resolveConfigPaths({ cwd }).catch(() => undefined);
  let updateStatus = "run `orchivox update --check`";
  if (options.checkUpdates) {
    if (info.installMethod === "source") {
      updateStatus = "source checkout (run `orchivox update --check`)";
    } else {
      try {
        const check = await fetchUpdateCheck({
          currentVersion: info.version,
          timeoutMs: 5_000,
        });
        updateStatus = check.available
          ? `${check.latest} available (run \`orchivox update\`)`
          : "up to date";
      } catch (error) {
        updateStatus = `check failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  const lines = [
    formatAppInfo(info),
    `update     ${updateStatus}`,
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
