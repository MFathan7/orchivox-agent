import { existsSync } from "node:fs";

import { InstallerError, type PlatformId } from "./types";

export const SUPPORTED_PLATFORMS: PlatformId[] = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "windows-x64",
];

export function platformId(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  libc?: "glibc" | "musl",
): PlatformId {
  if (platform === "linux") {
    if (libc === "musl") {
      throw new InstallerError(
        "unsupported_platform",
        "Linux musl is not supported. Use a glibc based distribution, or install the release binary manually.",
      );
    }
    if (arch === "x64") return "linux-x64";
    if (arch === "arm64") return "linux-arm64";
  }

  if (platform === "darwin") {
    if (arch === "x64") return "darwin-x64";
    if (arch === "arm64") return "darwin-arm64";
  }

  if (platform === "win32" && arch === "x64") {
    return "windows-x64";
  }

  throw new InstallerError(
    "unsupported_platform",
    `Unsupported platform: ${platform}/${arch}. Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}.`,
  );
}

export function detectLibc(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): "glibc" | "musl" | undefined {
  if (platform !== "linux") return undefined;

  const report = (process as unknown as {
    report?: { getReport?: () => { header?: { glibcVersionRuntime?: string } } };
  }).report;
  const glibc = report?.getReport?.().header?.glibcVersionRuntime;
  if (glibc) return "glibc";

  if (arch === "x64" && existsSync("/lib/ld-musl-x86_64.so.1")) return "musl";
  if (arch === "arm64" && existsSync("/lib/ld-musl-aarch64.so.1")) return "musl";
  return "glibc";
}

export function currentPlatform(): PlatformId {
  return platformId(process.platform, process.arch, detectLibc());
}

export function binaryNameForPlatform(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "orchivox.exe" : "orchivox";
}

export function platformLabel(id: PlatformId): string {
  switch (id) {
    case "linux-x64":
      return "Linux x64 (glibc)";
    case "linux-arm64":
      return "Linux arm64 (glibc)";
    case "darwin-x64":
      return "macOS Intel";
    case "darwin-arm64":
      return "macOS Apple Silicon";
    case "windows-x64":
      return "Windows x64";
  }
}
