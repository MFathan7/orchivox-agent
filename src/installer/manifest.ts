import { resolveReleasePublicKey, verifyManifestSignature } from "./signature";
import { InstallerError, type PlatformId, type ReleaseAsset, type ReleaseManifest } from "./types";

export const DEFAULT_REPOSITORY = "MFathan7/orchivox-agent";
export const DEFAULT_MANIFEST_URL =
  `https://github.com/${DEFAULT_REPOSITORY}/releases/latest/download/latest.json`;

export interface FetchManifestOptions {
  url?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FetchSignedManifestOptions extends FetchManifestOptions {
  signatureUrl?: string;
  publicKey?: string;
  skipSignature?: boolean;
}

export function manifestUrlForVersion(version: string, repository = DEFAULT_REPOSITORY): string {
  const clean = version.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(clean)) {
    throw new InstallerError("invalid_version", `Invalid version: ${version}`);
  }
  return `https://github.com/${repository}/releases/download/v${clean}/latest.json`;
}

export function resolveManifestUrl(options: {
  version?: string;
  url?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  if (options.url) return options.url;
  const env = options.env ?? process.env;
  if (env.ORCHIVOX_MANIFEST_URL) return env.ORCHIVOX_MANIFEST_URL;
  if (options.version) return manifestUrlForVersion(options.version);
  return DEFAULT_MANIFEST_URL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value)) {
    throw new InstallerError("invalid_manifest", "Release manifest is not a JSON object.");
  }
  if (value.schema !== 1) {
    throw new InstallerError(
      "invalid_manifest",
      `Unsupported manifest schema: ${String(value.schema)}.`,
    );
  }
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)) {
    throw new InstallerError("invalid_manifest", "Release manifest has an invalid version.");
  }
  if (typeof value.channel !== "string" || value.channel.length === 0) {
    throw new InstallerError("invalid_manifest", "Release manifest has an invalid channel.");
  }
  if (typeof value.published_at !== "string" || value.published_at.length === 0) {
    throw new InstallerError("invalid_manifest", "Release manifest has an invalid published_at.");
  }
  if (typeof value.notes_url !== "string" || value.notes_url.length === 0) {
    throw new InstallerError("invalid_manifest", "Release manifest has an invalid notes_url.");
  }
  if (!isRecord(value.assets)) {
    throw new InstallerError("invalid_manifest", "Release manifest has no assets.");
  }

  const assets: Record<string, ReleaseAsset> = {};
  for (const [id, raw] of Object.entries(value.assets)) {
    if (!isRecord(raw)) {
      throw new InstallerError("invalid_manifest", `Asset ${id} is not an object.`);
    }
    if (typeof raw.url !== "string" || !/^https?:\/\//.test(raw.url)) {
      throw new InstallerError("invalid_manifest", `Asset ${id} has an invalid URL.`);
    }
    if (typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(raw.sha256)) {
      throw new InstallerError("invalid_manifest", `Asset ${id} has an invalid SHA-256.`);
    }
    if (typeof raw.size !== "number" || !Number.isFinite(raw.size) || raw.size <= 0) {
      throw new InstallerError("invalid_manifest", `Asset ${id} has an invalid size.`);
    }
    assets[id] = {
      url: raw.url,
      sha256: raw.sha256.toLowerCase(),
      size: Math.floor(raw.size),
    };
  }

  return {
    schema: 1,
    version: value.version,
    channel: value.channel,
    published_at: value.published_at,
    notes_url: value.notes_url,
    assets,
  };
}

async function fetchBytes(
  url: string,
  options: FetchManifestOptions & { accept?: string },
): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();

  try {
    const response = await fetchImpl(url, {
      headers: {
        "user-agent": "orchivox-installer",
        accept: options.accept ?? "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new InstallerError(
        "fetch_failed",
        `Request failed (${response.status} ${response.statusText}): ${url}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (options.signal?.aborted) {
      throw new InstallerError("cancelled", "Installation cancelled.");
    }
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      "fetch_failed",
      `Request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    options.signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
  }
}

export async function fetchManifest(options: FetchManifestOptions = {}): Promise<ReleaseManifest> {
  const url = resolveManifestUrl({
    url: options.url,
    env: options.env,
  });
  try {
    const bytes = await fetchBytes(url, { ...options, accept: "application/json" });
    return parseManifest(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof InstallerError && error.code === "cancelled") throw error;
    if (error instanceof InstallerError && error.code === "invalid_manifest") throw error;
    throw new InstallerError(
      "manifest_fetch_failed",
      `Could not fetch release manifest from ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function fetchSignedManifest(
  options: FetchSignedManifestOptions = {},
): Promise<ReleaseManifest> {
  const env = options.env ?? process.env;
  if (options.skipSignature || env.ORCHIVOX_SKIP_SIGNATURE === "1") {
    return fetchManifest(options);
  }

  const url = resolveManifestUrl({ url: options.url, env });
  const signatureUrl = options.signatureUrl ?? `${url}.sig`;
  let manifestBytes: Buffer;
  try {
    manifestBytes = await fetchBytes(url, { ...options, accept: "application/json" });
  } catch (error) {
    if (error instanceof InstallerError && error.code === "cancelled") throw error;
    throw new InstallerError(
      "manifest_fetch_failed",
      `Could not fetch release manifest from ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let manifest: ReleaseManifest;
  try {
    manifest = parseManifest(JSON.parse(manifestBytes.toString("utf8")));
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      "invalid_manifest",
      `Release manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let signature: Buffer;
  try {
    signature = await fetchBytes(signatureUrl, { ...options, accept: "text/plain" });
  } catch (error) {
    if (error instanceof InstallerError && error.code === "cancelled") throw error;
    throw new InstallerError(
      "signature_missing",
      `Could not fetch release signature from ${signatureUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  verifyManifestSignature(
    manifestBytes,
    signature.toString("utf8"),
    options.publicKey ?? resolveReleasePublicKey(env),
  );
  return manifest;
}

export function assetForPlatform(
  manifest: ReleaseManifest,
  platform: PlatformId,
): ReleaseAsset {
  const asset = manifest.assets[platform];
  if (!asset) {
    throw new InstallerError(
      "missing_asset",
      `Release ${manifest.version} has no asset for ${platform}.`,
    );
  }
  return asset;
}
