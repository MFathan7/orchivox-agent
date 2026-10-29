export type PlatformId =
  | "linux-x64"
  | "linux-arm64"
  | "darwin-x64"
  | "darwin-arm64"
  | "windows-x64";

export type InstallMethod = "standalone" | "source" | "npm" | "bun";

export interface ReleaseAsset {
  url: string;
  sha256: string;
  size: number;
}

export interface ReleaseManifest {
  schema: number;
  version: string;
  channel: string;
  published_at: string;
  notes_url: string;
  assets: Record<string, ReleaseAsset>;
}

export interface DownloadProgress {
  received: number;
  total: number;
  percent: number;
  bytesPerSecond: number;
  etaSeconds: number;
}

export interface InstallRecord {
  schema: number;
  version: string;
  platform: PlatformId;
  channel: string;
  method: InstallMethod;
  binary: string;
  installed_at: string;
  previous?: string;
  launcher_version?: string;
}

export interface InstallPaths {
  baseDir: string;
  versionsDir: string;
  binDir: string;
  installFile: string;
  binaryPath: string;
  binaryName: string;
}

export interface InstallResult {
  version: string;
  binaryPath: string;
  downloaded: boolean;
  record: InstallRecord;
}

export class InstallerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InstallerError";
    this.code = code;
  }
}
