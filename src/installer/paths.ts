import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

import { binaryNameForPlatform, currentPlatform } from "./platform";
import type { InstallPaths, InstallRecord } from "./types";

export function resolveInstallPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): InstallPaths {
  const baseDir = resolve(
    env.ORCHIVOX_INSTALL_DIR?.trim() || join(homedir(), ".orchivox"),
  );
  const binaryName = binaryNameForPlatform(platform);
  return {
    baseDir,
    versionsDir: join(baseDir, "versions"),
    binDir: join(baseDir, "bin"),
    installFile: join(baseDir, "install.json"),
    binaryPath: join(baseDir, "bin", binaryName),
    binaryName,
  };
}

export function versionedBinaryPath(paths: InstallPaths, version: string): string {
  return join(paths.versionsDir, version, paths.binaryName);
}

export function ensureInstallDirs(paths: InstallPaths): void {
  for (const dir of [paths.baseDir, paths.versionsDir, paths.binDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Windows and some filesystems do not expose POSIX modes.
    }
  }
}

export function readInstallRecord(paths: InstallPaths): InstallRecord | undefined {
  if (!existsSync(paths.installFile)) return undefined;
  try {
    const value = JSON.parse(readFileSync(paths.installFile, "utf8")) as Partial<InstallRecord>;
    if (
      value.schema !== 1 ||
      typeof value.version !== "string" ||
      typeof value.platform !== "string" ||
      typeof value.channel !== "string" ||
      typeof value.method !== "string" ||
      typeof value.binary !== "string" ||
      typeof value.installed_at !== "string"
    ) {
      return undefined;
    }
    return value as InstallRecord;
  } catch {
    return undefined;
  }
}

export function writeInstallRecord(paths: InstallPaths, record: InstallRecord): void {
  ensureInstallDirs(paths);
  const temp = `${paths.installFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  if (process.platform === "win32") {
    rmSync(paths.installFile, { force: true });
  }
  renameSync(temp, paths.installFile);
}

export function migrateLegacyInstall(paths: InstallPaths): InstallRecord | undefined {
  const existing = readInstallRecord(paths);
  if (existing) return existing;

  const legacyPath = join(paths.baseDir, "install_source.json");
  if (!existsSync(legacyPath)) return undefined;

  try {
    const legacy = JSON.parse(readFileSync(legacyPath, "utf8")) as {
      version?: unknown;
      installedAt?: unknown;
    };
    if (typeof legacy.version !== "string" || legacy.version.length === 0) return undefined;
    if (!existsSync(paths.binaryPath)) return undefined;

    const record: InstallRecord = {
      schema: 1,
      version: legacy.version,
      platform: currentPlatform(),
      channel: "stable",
      method: "source",
      binary: relative(paths.baseDir, paths.binaryPath),
      installed_at:
        typeof legacy.installedAt === "string"
          ? legacy.installedAt
          : new Date().toISOString(),
    };
    writeInstallRecord(paths, record);
    return record;
  } catch {
    return undefined;
  }
}

export function installedBinaryPath(
  paths: InstallPaths,
  record: InstallRecord | undefined = readInstallRecord(paths),
): string | undefined {
  if (record) {
    const candidate = resolve(paths.baseDir, record.binary);
    const insideBase = !relative(paths.baseDir, candidate).startsWith("..");
    if (insideBase && existsSync(candidate)) return candidate;
  }
  if (existsSync(paths.binaryPath)) return paths.binaryPath;
  return undefined;
}

export function relativeBinaryPath(paths: InstallPaths, version: string): string {
  return relative(paths.baseDir, versionedBinaryPath(paths, version));
}
