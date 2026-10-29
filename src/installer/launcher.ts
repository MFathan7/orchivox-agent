import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../../package.json";
import { INSTALL_HELP, runInstallCommand } from "./cli";
import { installedBinaryPath, resolveInstallPaths } from "./paths";
import { InstallerError } from "./types";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export function findPackageRoot(start = moduleDir): string | undefined {
  let current = resolve(start);
  while (true) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const value = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string };
        if (value.name === "orchivox" || value.name === "orchivox-agent") return current;
      } catch {
        // Keep walking upward.
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function isSourceCheckout(root: string): boolean {
  return existsSync(join(root, "src", "index.ts"));
}

function bunAvailable(): boolean {
  try {
    return spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function runProcess(command: string, args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolvePromise(code ?? (signal ? 1 : 0));
    });
  });
}

export function launcherHelp(root: string): string {
  return [
    `Orchivox launcher ${packageJson.version}`,
    "",
    "usage:",
    "  orchivox                 start the terminal UI",
    "  orchivox install         download and install the runtime",
    "  orchivox install --force reinstall the current release",
    "  orchivox update          update the installed runtime",
    "  orchivox self-update     alias for orchivox update",
    "  orchivox --version       print the installed runtime version",
    "  orchivox --help          show this help",
    "",
    isSourceCheckout(root)
      ? "Source checkout detected. Run `bun run start` for development."
      : "The runtime is not installed yet. Run `orchivox install`.",
    "",
    "install options:",
    INSTALL_HELP,
  ].join("\n");
}

export function detectLaunchMode(
  argv1 = process.argv[1] ?? "",
  env: NodeJS.ProcessEnv = process.env,
): "npx" | "bunx" | "npm" | "bun" | "source" | "direct" {
  if (argv1.includes("/_npx/") || argv1.includes("\\_npx\\")) return "npx";
  if (argv1.includes("/.bun/install/cache/") || argv1.includes("/.bunx/")) return "bunx";
  if (argv1.includes("/.bun/install/global/")) return "bun";
  if (env.npm_config_user_agent?.startsWith("bun/") && argv1.includes("node_modules")) {
    return "bun";
  }
  if (argv1.includes("node_modules")) return "npm";
  return "direct";
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const root = findPackageRoot() ?? resolve(moduleDir, "..");
  if (!process.env.ORCHIVOX_LAUNCH_MODE) {
    process.env.ORCHIVOX_LAUNCH_MODE = isSourceCheckout(root) ? "source" : detectLaunchMode();
  }

  if (argv[0] === "install") {
    await runInstallCommand(argv.slice(1), {
      launcherVersion: packageJson.version,
    });
    return 0;
  }

  if (isSourceCheckout(root) && process.env.ORCHIVOX_DEV !== "0" && bunAvailable()) {
    return runProcess("bun", ["run", join(root, "src", "index.ts"), ...argv]);
  }

  const paths = resolveInstallPaths();
  const binary = installedBinaryPath(paths);

  if (!binary) {
    if (argv.includes("-h") || argv.includes("--help")) {
      console.log(launcherHelp(root));
      return 0;
    }
    if (argv.includes("--version")) {
      console.log(`Orchivox launcher ${packageJson.version} (runtime not installed)`);
      return 0;
    }

    console.log(`Orchivox is not installed yet. Installing launcher ${packageJson.version}...`);
    const result = await runInstallCommand([], {
      launcherVersion: packageJson.version,
    });
    if (!result) return 0;
    const installed = installedBinaryPath(paths) ?? result.binaryPath;
    return runProcess(installed, argv);
  }

  return runProcess(binary, argv);
}

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

const isEntryPoint =
  Boolean(process.argv[1]) && sameFile(process.argv[1], fileURLToPath(import.meta.url));

if (isEntryPoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const cancelled = error instanceof InstallerError && error.code === "cancelled";
      if (!cancelled) {
        const message =
          error instanceof InstallerError || error instanceof Error
            ? error.message
            : String(error);
        console.error(`orchivox: ${message}`);
      }
      process.exitCode = cancelled ? 130 : 1;
    });
}
