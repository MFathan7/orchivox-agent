import { existsSync } from "node:fs";

import { installRelease } from "./install";
import { assetForPlatform, fetchSignedManifest, resolveManifestUrl } from "./manifest";
import {
  addToShellPath,
  addToWindowsUserPath,
  isCommandOnPath,
  pathHint,
} from "./path-setup";
import { readInstallRecord, resolveInstallPaths, versionedBinaryPath } from "./paths";
import { currentPlatform, platformLabel } from "./platform";
import { InstallerError, type InstallResult } from "./types";
import { createInstallerUI, formatBytes, type InstallerUI } from "./ui";

export interface InstallCliOptions {
  force: boolean;
  version?: string;
  manifestUrl?: string;
  installDir?: string;
  yes: boolean;
  addPath: boolean;
  noPath: boolean;
  noAnim: boolean;
  noColor: boolean;
  help: boolean;
}

export const INSTALL_HELP = [
  "usage:",
  "  orchivox install [options]",
  "",
  "options:",
  "  --force, -f             reinstall even when the same version exists",
  "  --version <semver>      install a specific release",
  "  --manifest-url <url>    use a custom latest.json",
  "  --install-dir <path>    install somewhere other than ~/.orchivox",
  "  --yes, -y               skip the install confirmation",
  "  --add-path              add the install directory to PATH without asking",
  "  --no-path               never modify PATH",
  "  --no-anim               disable spinner and transition animation",
  "  --no-color              disable ANSI colors",
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
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force" || arg === "-f") {
      options.force = true;
    } else if (arg === "--version") {
      options.version = argv[++index];
      if (!options.version) throw new InstallerError("invalid_args", "--version requires a value");
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
      ui.failActive(error.message);
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    ui.failActive(message);
    throw error;
  } finally {
    ui.close();
  }
}

async function configurePath(
  ui: InstallerUI,
  paths: ReturnType<typeof resolveInstallPaths>,
  parsed: InstallCliOptions,
  env: NodeJS.ProcessEnv,
): Promise<{ pathChanged: boolean; pathOnPath: boolean; commandPath: string }> {
  const launchMode = env.ORCHIVOX_LAUNCH_MODE ?? "";
  const commandOnPath =
    launchMode !== "npx" && launchMode !== "bunx" && isCommandOnPath("orchivox", env);
  if (commandOnPath) {
    return { pathChanged: false, pathOnPath: true, commandPath: "orchivox" };
  }

  if (parsed.noPath) {
    ui.info(`To run from anywhere, add ${paths.binDir} to PATH:`);
    ui.info(`  ${pathHint(paths.binDir, env)}`);
    return { pathChanged: false, pathOnPath: false, commandPath: paths.binaryPath };
  }

  let approved = parsed.addPath;
  if (!approved && ui.interactive && !parsed.yes) {
    approved = await ui.confirm(`Add ${paths.binDir} to PATH?`, true, false);
  }
  if (!approved) {
    ui.info(`To run from anywhere, add ${paths.binDir} to PATH:`);
    ui.info(`  ${process.platform === "win32" ? paths.binDir : pathHint(paths.binDir, env)}`);
    return { pathChanged: false, pathOnPath: false, commandPath: paths.binaryPath };
  }

  if (process.platform === "win32") {
    const result = addToWindowsUserPath(paths.binDir, env);
    ui.info(
      result.changed
        ? "Updated the Windows user PATH. Restart your terminal."
        : "Windows user PATH already contains the install directory.",
    );
    return { pathChanged: result.changed, pathOnPath: true, commandPath: "orchivox" };
  }

  const result = addToShellPath({ binDir: paths.binDir, env });
  ui.info(
    result.changed
      ? `Updated ${result.file}. Restart your shell to use \`orchivox\`.`
      : `${result.file} already contains the Orchivox PATH entry.`,
  );
  if (result.backup) ui.info(`Backup: ${result.backup}`);
  return { pathChanged: result.changed, pathOnPath: true, commandPath: "orchivox" };
}
