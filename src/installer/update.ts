import { existsSync } from "node:fs";

import { ensureBinaryLink, installRelease, runBinaryVersion } from "./install";
import { fetchSignedManifest } from "./manifest";
import {
  installedBinaryPath,
  readInstallRecord,
  relativeBinaryPath,
  versionedBinaryPath,
  writeInstallRecord,
} from "./paths";
import { InstallerError, type DownloadProgress, type InstallPaths, type InstallRecord, type InstallResult, type PlatformId, type ReleaseManifest } from "./types";

export interface UpdateCheck {
  current: string;
  latest: string;
  available: boolean;
  channel: string;
  notes_url: string;
  published_at: string;
}

export interface ApplyUpdateOptions {
  manifest: ReleaseManifest;
  currentVersion: string;
  platform: PlatformId;
  paths: InstallPaths;
  onProgress?: (progress: DownloadProgress) => void;
  onStage?: (stage: "download" | "verify" | "install" | "link") => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  launcherVersion?: string;
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [core, prerelease] = value.split("-", 2);
    return {
      numbers: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      prerelease: prerelease ? prerelease.split(".") : undefined,
    };
  };
  const a = parse(left);
  const b = parse(right);

  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) {
      return a.numbers[index] > b.numbers[index] ? 1 : -1;
    }
  }

  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (!a.prerelease && !b.prerelease) return 0;

  const leftParts = a.prerelease ?? [];
  const rightParts = b.prerelease ?? [];
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] === undefined) return -1;
    if (rightParts[index] === undefined) return 1;
    if (leftParts[index] === rightParts[index]) continue;
    const leftNumber = Number(leftParts[index]);
    const rightNumber = Number(rightParts[index]);
    const leftNumeric = Number.isFinite(leftNumber);
    const rightNumeric = Number.isFinite(rightNumber);
    if (leftNumeric && rightNumeric) return leftNumber > rightNumber ? 1 : -1;
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftParts[index] > rightParts[index] ? 1 : -1;
  }
  return 0;
}

export function checkUpdate(manifest: ReleaseManifest, currentVersion: string): UpdateCheck {
  return {
    current: currentVersion,
    latest: manifest.version,
    available: compareVersions(manifest.version, currentVersion) > 0,
    channel: manifest.channel,
    notes_url: manifest.notes_url,
    published_at: manifest.published_at,
  };
}

export function formatUpdateCheck(check: UpdateCheck): string {
  if (check.available) {
    return `${check.latest} is available (current ${check.current}). Run \`orchivox update\` to install it.`;
  }
  if (compareVersions(check.current, check.latest) > 0) {
    return `Installed ${check.current} is newer than the latest release ${check.latest}.`;
  }
  return `Already up to date: ${check.current}.`;
}

export async function fetchUpdateCheck(options: {
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<UpdateCheck> {
  const manifest = await fetchSignedManifest({
    env: options.env,
    url: options.url,
    timeoutMs: options.timeoutMs ?? 5_000,
    fetchImpl: options.fetchImpl,
  });
  return checkUpdate(manifest, options.currentVersion);
}

export async function applyUpdate(options: ApplyUpdateOptions): Promise<InstallResult> {
  const comparison = compareVersions(options.manifest.version, options.currentVersion);
  if (comparison <= 0) {
    throw new InstallerError(
      "already_current",
      `Orchivox ${options.currentVersion} is already at or above ${options.manifest.version}.`,
    );
  }
  return installRelease({
    manifest: options.manifest,
    platform: options.platform,
    paths: options.paths,
    onProgress: options.onProgress,
    onStage: options.onStage,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    launcherVersion: options.launcherVersion,
  });
}

export async function rollbackUpdate(options: {
  paths: InstallPaths;
}): Promise<InstallRecord> {
  const current = readInstallRecord(options.paths);
  if (!current) {
    throw new InstallerError("not_installed", "No managed Orchivox installation was found.");
  }
  if (!current.previous) {
    throw new InstallerError(
      "no_previous_version",
      "No previous Orchivox version is available to roll back to.",
    );
  }

  const target = versionedBinaryPath(options.paths, current.previous);
  if (!existsSync(target)) {
    throw new InstallerError(
      "previous_missing",
      `Previous Orchivox ${current.previous} is missing at ${target}.`,
    );
  }

  const reported = await runBinaryVersion(target);
  if (!reported.includes(current.previous)) {
    throw new InstallerError(
      "binary_validation_failed",
      `Previous binary reported ${reported.trim() || "no version"}, expected ${current.previous}.`,
    );
  }

  ensureBinaryLink(options.paths, target);
  const record: InstallRecord = {
    ...current,
    version: current.previous,
    previous: current.version,
    binary: relativeBinaryPath(options.paths, current.previous),
    installed_at: new Date().toISOString(),
  };
  writeInstallRecord(options.paths, record);

  if (!installedBinaryPath(options.paths, record)) {
    throw new InstallerError("rollback_failed", "Could not activate the previous Orchivox binary.");
  }
  return record;
}
