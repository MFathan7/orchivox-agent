import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";

import { downloadToFile } from "./download";
import { assetForPlatform } from "./manifest";
import {
  ensureInstallDirs,
  installedBinaryPath,
  readInstallRecord,
  relativeBinaryPath,
  versionedBinaryPath,
  writeInstallRecord,
} from "./paths";
import { InstallerError, type DownloadProgress, type InstallPaths, type InstallRecord, type InstallResult, type PlatformId, type ReleaseManifest } from "./types";

const execFileAsync = promisify(execFile);

export type InstallStage = "download" | "verify" | "install" | "link";

export interface InstallReleaseOptions {
  manifest: ReleaseManifest;
  platform: PlatformId;
  paths: InstallPaths;
  force?: boolean;
  onProgress?: (progress: DownloadProgress) => void;
  onStage?: (stage: InstallStage) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  launcherVersion?: string;
  binaryRunner?: (binaryPath: string) => Promise<string>;
}

export async function installRelease(options: InstallReleaseOptions): Promise<InstallResult> {
  const { manifest, platform, paths } = options;
  const current = readInstallRecord(paths);
  const targetBinary = versionedBinaryPath(paths, manifest.version);

  if (
    !options.force &&
    current &&
    current.version === manifest.version &&
    existsSync(targetBinary)
  ) {
    ensureBinaryLink(paths, targetBinary);
    return {
      version: manifest.version,
      binaryPath: installedBinaryPath(paths) ?? paths.binaryPath,
      downloaded: false,
      record: current,
    };
  }

  ensureInstallDirs(paths);
  const asset = assetForPlatform(manifest, platform);
  const downloadDir = join(paths.baseDir, ".downloads");
  const downloadPath = join(
    downloadDir,
    `${manifest.version}-${platform}-${process.pid}-${Date.now()}.gz`,
  );
  const versionDir = dirname(targetBinary);
  const tempBinary =
    process.platform === "win32"
      ? `${targetBinary}.${process.pid}.tmp.exe`
      : `${targetBinary}.${process.pid}.tmp`;

  try {
    await mkdir(downloadDir, { recursive: true, mode: 0o700 });
    await mkdir(versionDir, { recursive: true, mode: 0o700 });

    options.onStage?.("download");
    const download = await downloadToFile({
      url: asset.url,
      destination: downloadPath,
      expectedSha256: asset.sha256,
      expectedSize: asset.size,
      onProgress: options.onProgress,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });

    options.onStage?.("verify");
    if (options.signal?.aborted) {
      throw new InstallerError("cancelled", "Installation cancelled.");
    }

    options.onStage?.("install");
    await pipeline(
      createReadStream(download.path),
      createGunzip(),
      createWriteStream(tempBinary, { mode: 0o755 }),
    );
    chmodSync(tempBinary, 0o755);
    if (options.signal?.aborted) {
      throw new InstallerError("cancelled", "Installation cancelled.");
    }

    const reported = await (options.binaryRunner ?? runBinaryVersion)(tempBinary);
    if (!reported.includes(manifest.version)) {
      throw new InstallerError(
        "binary_validation_failed",
        `Downloaded binary reported ${reported.trim() || "no version"}, expected ${manifest.version}.`,
      );
    }
    if (options.signal?.aborted) {
      throw new InstallerError("cancelled", "Installation cancelled.");
    }

    if (existsSync(targetBinary)) {
      rmSync(targetBinary, { force: true });
    }
    renameSync(tempBinary, targetBinary);
    chmodSync(targetBinary, 0o755);
    options.onStage?.("link");
    ensureBinaryLink(paths, targetBinary);

    const record: InstallRecord = {
      schema: 1,
      version: manifest.version,
      platform,
      channel: manifest.channel,
      method: "standalone",
      binary: relativeBinaryPath(paths, manifest.version),
      installed_at: new Date().toISOString(),
      previous:
        current && current.version !== manifest.version ? current.version : current?.previous,
      launcher_version: options.launcherVersion,
    };
    writeInstallRecord(paths, record);

    return {
      version: manifest.version,
      binaryPath: paths.binaryPath,
      downloaded: true,
      record,
    };
  } catch (error) {
    rmSync(tempBinary, { force: true });
    if (options.signal?.aborted) {
      throw new InstallerError("cancelled", "Installation cancelled.");
    }
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      "install_failed",
      `Could not install Orchivox ${manifest.version}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(downloadPath, { force: true }).catch(() => undefined);
  }
}

export function ensureBinaryLink(paths: InstallPaths, targetBinary: string): void {
  mkdirSync(paths.binDir, { recursive: true, mode: 0o700 });

  if (process.platform === "win32") {
    const temp = `${paths.binaryPath}.${process.pid}.tmp`;
    const previous = `${paths.binaryPath}.${process.pid}.old`;
    rmSync(temp, { force: true });
    // Windows cannot create symlinks without privileges. Renaming the running
    // executable is allowed, so move it aside and copy the new binary in place.
    try {
      rmSync(previous, { force: true });
      renameSync(paths.binaryPath, previous);
    } catch {
      // First install, or the previous file is already gone.
    }
    try {
      copyFileSync(targetBinary, temp);
      chmodSync(temp, 0o755);
      renameSync(temp, paths.binaryPath);
    } catch (error) {
      try {
        if (!existsSync(paths.binaryPath) && existsSync(previous)) {
          renameSync(previous, paths.binaryPath);
        }
      } catch {
        // Best effort restore.
      }
      throw error;
    }
    try {
      rmSync(previous, { force: true });
    } catch {
      // The old executable is still running; remove it on the next update.
    }
    return;
  }

  const tempLink = `${paths.binaryPath}.${process.pid}.tmp`;
  rmSync(tempLink, { force: true });
  symlinkSync(relative(paths.binDir, targetBinary), tempLink);
  renameSync(tempLink, paths.binaryPath);
}

export async function runBinaryVersion(binaryPath: string): Promise<string> {
  try {
    const result = await execFileAsync(binaryPath, ["--version"], {
      timeout: 15_000,
      maxBuffer: 1_000_000,
      env: process.env,
    });
    return `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    throw new InstallerError(
      "binary_validation_failed",
      `Could not run the downloaded binary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
