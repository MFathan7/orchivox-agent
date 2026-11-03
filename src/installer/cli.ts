import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { installLocalBinary, installRelease, isolatedVersionEnv, runBinaryVersion } from "./install";
import { assetForPlatform, fetchSignedManifest, resolveManifestUrl } from "./manifest";
import {
  addToShellPath,
  configureWindowsPath,
  isCommandOnPath,
  isCommandUsableOnWindows,
  pathHint,
} from "./path-setup";
import { readInstallRecord, resolveInstallPaths, versionedBinaryPath } from "./paths";
import { currentPlatform, platformLabel } from "./platform";
import { InstallerError, type InstallResult } from "./types";
import { createInstallerUI, formatBytes, type InstallerUI } from "./ui";

export interface InstallCliOptions {
  force: boolean;
  version?: string;
  binary?: string;
  manifestUrl?: string;
  installDir?: string;
  yes: boolean;
  addPath: boolean;
  noPath: boolean;
  noAnim: boolean;
  noColor: boolean;
  verbose: boolean;
  help: boolean;
}

export const INSTALL_HELP = [
  "usage:",
  "  orchivox install [options]",
  "",
  "options:",
  "  --force, -f             reinstall even when the same version exists",
  "  --version <semver>      install a specific release",
  "  --binary <path>         install a local binary instead of downloading",
  "  --manifest-url <url>    use a custom latest.json",
  "  --install-dir <path>    install somewhere other than ~/.orchivox",
  "  --yes, -y               skip the install confirmation",
  "  --add-path              add the install directory to PATH without asking",
  "  --no-path               never modify PATH",
  "  --no-anim               disable spinner and transition animation",
  "  --no-color              disable ANSI colors",
  "  --verbose               print installer diagnostics",
  "  -h, --help              show this help",
].join("\n");

export function parseInstallArgs(argv: string[]): InstallCliOptions {
  const options: InstallCliOptions = {
    force: false,
    yes: false,
    addPath: false,
    noPath: false,
    noAnim: false,
    noColor: false,
    verbose: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force" || arg === "-f") {
      options.force = true;
    } else if (arg === "--version") {
      options.version = argv[++index];
      if (!options.version) throw new InstallerError("invalid_args", "--version requires a value");
    } else if (arg === "--binary") {
      options.binary = argv[++index];
      if (!options.binary) throw new InstallerError("invalid_args", "--binary requires a value");
    } else if (arg === "--manifest-url") {
      options.manifestUrl = argv[++index];
      if (!options.manifestUrl) {
        throw new InstallerError("invalid_args", "--manifest-url requires a value");
      }
    } else if (arg === "--install-dir") {
      options.installDir = argv[++index];
      if (!options.installDir) {
        throw new InstallerError("invalid_args", "--install-dir requires a value");
      }
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--add-path") {
      options.addPath = true;
    } else if (arg === "--no-path") {
      options.noPath = true;
    } else if (arg === "--no-anim") {
      options.noAnim = true;
    } else if (arg === "--no-color") {
      options.noColor = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      throw new InstallerError("invalid_args", `Unknown install argument: ${arg}`);
    }
  }

  if (options.addPath && options.noPath) {
    throw new InstallerError("invalid_args", "--add-path and --no-path cannot be used together");
  }

  return options;
}

export async function runInstallCommand(
  argv: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    ui?: InstallerUI;
    launcherVersion?: string;
    fetchImpl?: typeof fetch;
    method?: "source" | "local";
    extraLinkPaths?: string[];
  } = {},
): Promise<InstallResult | undefined> {
  const parsed = parseInstallArgs(argv);
  if (parsed.help) {
    console.log(INSTALL_HELP);
    return undefined;
  }

  const env = {
    ...(options.env ?? process.env),
    ...(parsed.installDir ? { ORCHIVOX_INSTALL_DIR: parsed.installDir } : {}),
  } as NodeJS.ProcessEnv;

  if (parsed.binary) {
    return runLocalInstallCommand({
      binaryPath: resolve(parsed.binary),
      version: parsed.version,
      method: options.method ?? "local",
      parsed,
      env,
      ui: options.ui,
      launcherVersion: options.launcherVersion,
      extraLinkPaths: options.extraLinkPaths,
    });
  }

  const paths = resolveInstallPaths(env);
  const platform = currentPlatform();
  const platformName = platformLabel(platform);
  const ui =
    options.ui ??
    createInstallerUI({
      env,
      color: !parsed.noColor && !env.NO_COLOR && Boolean(process.stdout.isTTY),
      animations: !parsed.noAnim && !env.CI && env.TERM !== "dumb",
    });

  try {
    await ui.banner(options.launcherVersion ?? "dev", platformName);
    if (!ui.interactive) {
      ui.info(`Platform: ${platformName}`);
    }
    const inactive = ui.inactiveReason();
    if (inactive) ui.info(inactive);
    if (parsed.verbose) {
      ui.info(
        `installer: ${ui.diagnostics()} platform=${platformName} launch=${env.ORCHIVOX_LAUNCH_MODE ?? "direct"} install=${paths.baseDir}`,
      );
    }
    ui.info("Resolving release...");

    const manifestUrl = resolveManifestUrl({
      version: parsed.version,
      url: parsed.manifestUrl ?? env.ORCHIVOX_MANIFEST_URL,
      env,
    });
    const manifest = await fetchSignedManifest({
      url: manifestUrl,
      env,
      fetchImpl: options.fetchImpl,
      signal: ui.signal,
    });

    if (parsed.version) {
      const expected = parsed.version.replace(/^v/, "");
      if (manifest.version !== expected) {
        throw new InstallerError(
          "invalid_manifest",
          `Requested version ${expected}, but the manifest reports ${manifest.version}.`,
        );
      }
    }

    const asset = assetForPlatform(manifest, platform);
    const current = readInstallRecord(paths);
    const alreadyInstalled =
      !parsed.force &&
      current?.version === manifest.version &&
      existsSync(versionedBinaryPath(paths, manifest.version));

    if (alreadyInstalled) {
      const result = await installRelease({
        manifest,
        platform,
        paths,
        signal: ui.signal,
        launcherVersion: options.launcherVersion,
        fetchImpl: options.fetchImpl,
      });
      ui.info(`Orchivox ${manifest.version} is already installed at ${result.binaryPath}.`);
      ui.info("Use `orchivox install --force` to reinstall.");
      const pathResult = await configurePath(ui, paths, parsed, env);
      ui.summary({
        version: result.version,
        binaryPath: result.binaryPath,
        commandPath: pathResult.commandPath,
        pathChanged: pathResult.pathChanged,
        pathOnPath: pathResult.pathOnPath,
      });
      ui.info(`Release notes: ${manifest.notes_url}`);
      return result;
    }

    ui.intro(manifest.version, manifest.channel, asset.size);
    const approved = await ui.confirm("Install now?", true, parsed.yes);
    if (!approved) {
      ui.info("Install cancelled.");
      return undefined;
    }

    ui.startSteps(
      [
        { id: "detect", label: "Detect platform", detail: platformName },
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

    const result = await installRelease({
      manifest,
      platform,
      paths,
      force: parsed.force,
      launcherVersion: options.launcherVersion,
      fetchImpl: options.fetchImpl,
      signal: ui.signal,
      onProgress: (progress) => ui.progress(progress),
      onStage(stage) {
        if (stage === "download") {
          ui.stage("download", formatBytes(asset.size));
        } else if (stage === "verify") {
          ui.completeStep("download", formatBytes(asset.size));
          ui.stage("verify", "SHA-256");
        } else if (stage === "install") {
          ui.stage("install", `v${manifest.version}`);
        } else if (stage === "link") {
          ui.stage("link", paths.binaryPath);
        }
      },
    });

    ui.finishSteps();
    const pathResult = await configurePath(ui, paths, parsed, env);
    ui.summary({
      version: result.version,
      binaryPath: result.binaryPath,
      commandPath: pathResult.commandPath,
      pathChanged: pathResult.pathChanged,
      pathOnPath: pathResult.pathOnPath,
    });
    ui.info(`Release notes: ${manifest.notes_url}`);
    ui.info("Run `orchivox` to start.");

    return result;
  } catch (error) {
    if (error instanceof InstallerError && error.code === "cancelled") {
      ui.warn("Installation cancelled.");
      throw error;
    }
    if (error instanceof InstallerError) {
      const marked = ui.failActive(error.message);
      if (!marked || !ui.interactive || error.message.includes("\n")) ui.error(error.message);
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const marked = ui.failActive(message);
    if (!marked || !ui.interactive || message.includes("\n")) ui.error(message);
    throw error;
  } finally {
    ui.close();
  }
}

export interface LocalInstallCommandOptions {
  binaryPath: string;
  version?: string;
  method?: "source" | "local";
  parsed: InstallCliOptions;
  env?: NodeJS.ProcessEnv;
  ui?: InstallerUI;
  launcherVersion?: string;
  extraLinkPaths?: string[];
  build?: () => Promise<void>;
}

/**
 * Installs a binary that already exists on disk. Source installs use the
 * build callback so the same UI can show the compile step.
 */
export async function runLocalInstallCommand(
  options: LocalInstallCommandOptions,
): Promise<InstallResult | undefined> {
  if (options.parsed.help) {
    console.log(INSTALL_HELP);
    return undefined;
  }

  const env = options.env ?? process.env;
  const paths = resolveInstallPaths(env);
  const platform = currentPlatform();
  const platformName = platformLabel(platform);
  const ui =
    options.ui ??
    createInstallerUI({
      env,
      color: !options.parsed.noColor && !env.NO_COLOR && Boolean(process.stdout.isTTY),
      animations: !options.parsed.noAnim && !env.CI && env.TERM !== "dumb",
    });
  const closeUi = !options.ui;

  try {
    const binaryPath = resolve(options.binaryPath);
    if (!existsSync(binaryPath)) {
      throw new InstallerError("binary_not_found", `Local binary not found: ${binaryPath}`);
    }

    let version = options.version;
    let reported: string | undefined;
    if (!version) {
      reported = await runBinaryVersion(binaryPath, isolatedVersionEnv(env));
      version = parseBinaryVersion(reported);
      if (!version) {
        throw new InstallerError(
          "invalid_version",
          "Could not determine the local binary version. Pass --version <semver>.",
        );
      }
    }

    await ui.banner(version, platformName);
    if (!ui.interactive) {
      ui.info(`Platform: ${platformName}`);
    }
    const inactive = ui.inactiveReason();
    if (inactive) ui.info(inactive);
    if (options.parsed.verbose) {
      ui.info(
        `installer: ${ui.diagnostics()} platform=${platformName} launch=${env.ORCHIVOX_LAUNCH_MODE ?? "direct"} install=${paths.baseDir}`,
      );
    }
    ui.info(
      options.build
        ? "Developer install from source."
        : `Installing local binary ${binaryPath}.`,
    );

    ui.startSteps([
      ...(options.build
        ? [{ id: "build", label: "Build", detail: "compiling runtime" }]
        : []),
      { id: "verify", label: "Verify", detail: "version check" },
      { id: "install", label: "Install", detail: paths.baseDir },
      { id: "link", label: "Link command", detail: paths.binaryPath },
    ]);

    if (options.build) {
      ui.stage("build", "compiling runtime");
      await options.build();
      ui.completeStep("build", "binary built");
    }

    ui.stage("verify", "version check");
    const output = reported ?? (await runBinaryVersion(binaryPath, isolatedVersionEnv(env)));
    const actual = parseBinaryVersion(output);
    if (actual !== version) {
      throw new InstallerError(
        "binary_validation_failed",
        `Local binary reported ${actual ?? "no version"}, expected ${version}.`,
      );
    }
    ui.completeStep("verify", `v${version}`);

    ui.stage("install", paths.baseDir);
    const result = await installLocalBinary({
      binaryPath,
      version,
      platform,
      paths,
      method: options.method ?? "local",
      extraLinkPaths: options.extraLinkPaths,
      launcherVersion: options.launcherVersion,
      onStage(stage) {
        if (stage === "link") ui.stage("link", paths.binaryPath);
      },
    });
    ui.completeStep("install", `v${version}`);
    ui.completeStep("link", "orchivox");
    ui.finishSteps();

    const pathResult = await configurePath(ui, paths, options.parsed, env);
    ui.summary({
      version: result.version,
      binaryPath: result.binaryPath,
      commandPath: pathResult.commandPath,
      pathChanged: pathResult.pathChanged,
      pathOnPath: pathResult.pathOnPath,
    });
    ui.info("Run `orchivox` to start.");

    return result;
  } catch (error) {
    if (error instanceof InstallerError && error.code === "cancelled") {
      ui.warn("Installation cancelled.");
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const marked = ui.failActive(message.split("\n")[0]);
    if (!marked || !ui.interactive || message.includes("\n")) ui.error(message);
    throw error;
  } finally {
    if (closeUi) ui.close();
  }
}

function parseBinaryVersion(output: string): string | undefined {
  const match = output.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  return match?.[1];
}

async function configurePath(
  ui: InstallerUI,
  paths: ReturnType<typeof resolveInstallPaths>,
  parsed: InstallCliOptions,
  env: NodeJS.ProcessEnv,
): Promise<{ pathChanged: boolean; pathOnPath: boolean; commandPath: string }> {
  const launchMode = env.ORCHIVOX_LAUNCH_MODE ?? "";
  const windowsCommandPath = join(paths.binDir, "orchivox.cmd");

  if (parsed.noPath) {
    ui.info(`To run from anywhere, add ${paths.binDir} to PATH:`);
    ui.info(`  ${process.platform === "win32" ? windowsCommandPath : pathHint(paths.binDir, env)}`);
    return {
      pathChanged: false,
      pathOnPath: false,
      commandPath: process.platform === "win32" ? windowsCommandPath : paths.binaryPath,
    };
  }

  const commandOnPath =
    launchMode !== "npx" &&
    launchMode !== "bunx" &&
    (process.platform === "win32"
      ? isCommandUsableOnWindows("orchivox", env)
      : isCommandOnPath("orchivox", env));
  if (commandOnPath) {
    return { pathChanged: false, pathOnPath: true, commandPath: "orchivox" };
  }

  let approved = parsed.addPath;
  if (!approved && ui.interactive && !parsed.yes) {
    approved = await ui.confirm(`Add ${paths.binDir} to PATH?`, true, false);
  }
  if (!approved) {
    ui.info(`To run from anywhere, add ${paths.binDir} to PATH:`);
    ui.info(`  ${process.platform === "win32" ? windowsCommandPath : pathHint(paths.binDir, env)}`);
    return {
      pathChanged: false,
      pathOnPath: false,
      commandPath: process.platform === "win32" ? windowsCommandPath : paths.binaryPath,
    };
  }

  if (process.platform === "win32") {
    const result = configureWindowsPath(paths.binDir, env);
    if (result.pathOnPath) {
      ui.info(
        result.changed
          ? "Updated the Windows user PATH. Restart your terminal."
          : "Windows user PATH already contains the install directory.",
      );
      return { pathChanged: result.changed, pathOnPath: true, commandPath: "orchivox" };
    }
    ui.info(`Could not update the Windows user PATH: ${result.detail || "access denied"}`);
    ui.info(`Add this folder to your user PATH: ${paths.binDir}`);
    ui.info(`Or run ${windowsCommandPath} directly.`);
    return { pathChanged: false, pathOnPath: false, commandPath: windowsCommandPath };
  }

  try {
    const result = addToShellPath({ binDir: paths.binDir, env });
    ui.info(
      result.changed
        ? `Updated ${result.file}. Restart your shell to use \`orchivox\`.`
        : `${result.file} already contains the Orchivox PATH entry.`,
    );
    if (result.backup) ui.info(`Backup: ${result.backup}`);
    return { pathChanged: result.changed, pathOnPath: true, commandPath: "orchivox" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ui.info(`Could not update your shell config: ${detail}`);
    ui.info("Add this line to your shell config:");
    ui.info(`  ${pathHint(paths.binDir, env)}`);
    return { pathChanged: false, pathOnPath: false, commandPath: paths.binaryPath };
  }
}
