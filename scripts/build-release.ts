#!/usr/bin/env bun
import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import packageJson from "../package.json";

export const RELEASE_SCHEMA = 1;
export const RELEASE_CHANNEL = "stable";
export const DEFAULT_REPOSITORY = "MFathan7/orchivox-agent";

export type CompileTarget = Bun.Build.CompileTarget;

export interface ReleaseTarget {
  id: string;
  bunTarget: CompileTarget;
  asset: string;
}

export const RELEASE_TARGETS: ReleaseTarget[] = [
  { id: "linux-x64", bunTarget: "bun-linux-x64", asset: "orchivox-linux-x64.gz" },
  { id: "linux-arm64", bunTarget: "bun-linux-arm64", asset: "orchivox-linux-arm64.gz" },
  { id: "darwin-x64", bunTarget: "bun-darwin-x64", asset: "orchivox-darwin-x64.gz" },
  { id: "darwin-arm64", bunTarget: "bun-darwin-arm64", asset: "orchivox-darwin-arm64.gz" },
  { id: "windows-x64", bunTarget: "bun-windows-x64", asset: "orchivox-windows-x64.exe.gz" },
];

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

export interface ManifestOptions {
  version: string;
  outDir: string;
  baseUrl: string;
  notesUrl: string;
  channel?: string;
  publishedAt?: string;
}

export interface CliOptions {
  version?: string;
  outDir?: string;
  baseUrl?: string;
  notesUrl?: string;
  channel: string;
  signingKey?: string;
  requireSignature: boolean;
  manifestOnly: boolean;
  tag?: string;
  publishedAt?: string;
}

const ROOT = resolve(import.meta.dir, "..");

export function stripVersionPrefix(value: string): string {
  return value.startsWith("v") ? value.slice(1) : value;
}

export function assertSemver(version: string): string {
  const trimmed = version.trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmed)) {
    throw new Error(`invalid version: ${version}`);
  }
  return trimmed;
}

export function resolveVersion(explicit?: string): string {
  const version = assertSemver(explicit ?? packageJson.version);
  if (explicit && packageJson.version !== version) {
    throw new Error(
      `version mismatch: package.json has ${packageJson.version}, requested ${version}`,
    );
  }
  return version;
}

export function assertTagMatchesVersion(tag: string | undefined, version: string): void {
  if (!tag) return;
  const tagVersion = stripVersionPrefix(tag.trim());
  if (tagVersion !== version) {
    throw new Error(`tag mismatch: tag is ${tag}, package version is ${version}`);
  }
}

export function releaseBaseUrl(version: string, override?: string): string {
  if (override) return override.replace(/\/+$/, "");
  const repository = process.env.GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY;
  return `https://github.com/${repository}/releases/download/v${version}`;
}

export function releaseNotesUrl(version: string): string {
  const repository = process.env.GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY;
  return `https://github.com/${repository}/releases/tag/v${version}`;
}

export function assetPath(outDir: string, target: ReleaseTarget): string {
  return join(outDir, target.asset);
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function buildManifest(options: ManifestOptions): ReleaseManifest {
  const channel = options.channel ?? RELEASE_CHANNEL;
  const publishedAt = options.publishedAt ?? new Date().toISOString();
  const assets: Record<string, ReleaseAsset> = {};

  for (const target of RELEASE_TARGETS) {
    const path = assetPath(options.outDir, target);
    if (!existsSync(path)) {
      throw new Error(`missing release asset: ${path}`);
    }
    const bytes = readFileSync(path);
    assets[target.id] = {
      url: `${options.baseUrl}/${target.asset}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
  }

  return {
    schema: RELEASE_SCHEMA,
    version: options.version,
    channel,
    published_at: publishedAt,
    notes_url: options.notesUrl,
    assets,
  };
}

export function formatManifest(manifest: ReleaseManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function formatChecksums(entries: Array<{ file: string; sha256: string }>): string {
  return entries
    .slice()
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map((entry) => `${entry.sha256}  ${entry.file}`)
    .join("\n")
    .concat("\n");
}

export function loadPrivateKey(input: string) {
  const trimmed = input.trim();
  const material =
    trimmed.length < 4096 && existsSync(trimmed) ? readFileSync(trimmed, "utf8").trim() : trimmed;
  const pem = material.includes("BEGIN PRIVATE KEY")
    ? material
    : Buffer.from(material, "base64").toString("utf8");
  if (!pem.includes("BEGIN PRIVATE KEY")) {
    throw new Error("signing key must be a PKCS8 PEM key or base64-encoded PKCS8 PEM");
  }
  return createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
}

export function signManifest(manifestPath: string, signingKey: string): string {
  const signature = sign(null, readFileSync(manifestPath), loadPrivateKey(signingKey));
  return `${signature.toString("base64")}\n`;
}

function reactDevtoolsStub(): Bun.BunPlugin {
  return {
    name: "stub-react-devtools-core",
    setup(build) {
      build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
        path: "react-devtools-core",
        namespace: "orchivox-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "orchivox-stub" }, () => ({
        contents: "export default { connectToDevTools() {} };",
        loader: "js",
      }));
    },
  };
}

export async function buildTarget(target: ReleaseTarget, outDir: string): Promise<void> {
  const rawPath = assetPath(outDir, target).replace(/\.gz$/, "");
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src/index.ts")],
    compile: {
      target: target.bunTarget,
      outfile: rawPath,
    },
    plugins: [reactDevtoolsStub()],
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed for ${target.id}`);
  }

  const compressed = gzipSync(readFileSync(rawPath), { level: 9 });
  writeFileSync(assetPath(outDir, target), compressed);
  rmSync(rawPath, { force: true });
  console.log(
    `built ${target.id}: ${(compressed.length / 1_048_576).toFixed(1)} MB gzip`,
  );
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    channel: RELEASE_CHANNEL,
    requireSignature: false,
    manifestOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      options.version = argv[++index];
      if (!options.version) throw new Error("--version requires a value");
    } else if (arg === "--outdir") {
      options.outDir = argv[++index];
      if (!options.outDir) throw new Error("--outdir requires a value");
    } else if (arg === "--base-url") {
      options.baseUrl = argv[++index];
      if (!options.baseUrl) throw new Error("--base-url requires a value");
    } else if (arg === "--notes-url") {
      options.notesUrl = argv[++index];
      if (!options.notesUrl) throw new Error("--notes-url requires a value");
    } else if (arg === "--channel") {
      options.channel = argv[++index] ?? RELEASE_CHANNEL;
    } else if (arg === "--signing-key") {
      options.signingKey = argv[++index];
      if (!options.signingKey) throw new Error("--signing-key requires a value");
    } else if (arg === "--require-signature") {
      options.requireSignature = true;
    } else if (arg === "--manifest-only") {
      options.manifestOnly = true;
    } else if (arg === "--tag") {
      options.tag = argv[++index];
      if (!options.tag) throw new Error("--tag requires a value");
    } else if (arg === "--published-at") {
      options.publishedAt = argv[++index];
      if (!options.publishedAt) throw new Error("--published-at requires a value");
    } else if (arg === "-h" || arg === "--help") {
      console.log(HELP_TEXT);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

const HELP_TEXT = [
  "usage: bun run scripts/build-release.ts [options]",
  "",
  "options:",
  "  --version <semver>       release version, default package.json",
  "  --outdir <path>          output directory, default dist/release/v<version>",
  "  --base-url <url>         asset base URL, default GitHub release URL",
  "  --notes-url <url>        release notes URL",
  "  --channel <name>         release channel, default stable",
  "  --tag <tag>              validate that the tag matches the version",
  "  --signing-key <key>      PKCS8 PEM or base64-encoded PKCS8 PEM",
  "  --require-signature      fail when no signing key is available",
  "  --manifest-only          skip builds and regenerate manifest from assets",
  "  --published-at <iso>     fixed manifest timestamp for tests",
].join("\n");

function writeManifestFiles(options: {
  manifest: ReleaseManifest;
  outDir: string;
  signingKey?: string;
  requireSignature: boolean;
}): ReleaseManifest {
  const manifestPath = join(options.outDir, "latest.json");
  writeFileSync(manifestPath, formatManifest(options.manifest));

  const entries = RELEASE_TARGETS.map((target) => ({
    file: target.asset,
    sha256: sha256File(assetPath(options.outDir, target)),
  }));
  entries.push({ file: "latest.json", sha256: sha256File(manifestPath) });
  writeFileSync(join(options.outDir, "SHA256SUMS"), formatChecksums(entries));

  const signingKey = options.signingKey ?? process.env.ORCHIVOX_RELEASE_SIGNING_KEY;
  const signaturePath = join(options.outDir, "latest.json.sig");
  if (signingKey) {
    writeFileSync(signaturePath, signManifest(manifestPath, signingKey));
    console.log("signed latest.json with Ed25519");
  } else {
    rmSync(signaturePath, { force: true });
    if (options.requireSignature) {
      throw new Error(
        "signing key missing: pass --signing-key or set ORCHIVOX_RELEASE_SIGNING_KEY",
      );
    }
    console.warn("warning: latest.json is unsigned");
  }

  return options.manifest;
}

export async function runCli(argv: string[]): Promise<void> {
  const options = parseCliArgs(argv);
  const version = resolveVersion(options.version);
  assertTagMatchesVersion(options.tag, version);

  const outDir = resolve(options.outDir ?? join(ROOT, "dist", "release", `v${version}`));
  const baseUrl = releaseBaseUrl(version, options.baseUrl);
  const notesUrl = options.notesUrl ?? releaseNotesUrl(version);

  if (!options.manifestOnly) {
    mkdirSync(outDir, { recursive: true });
    for (const target of RELEASE_TARGETS) {
      await buildTarget(target, outDir);
    }
  }

  const manifest = buildManifest({
    version,
    outDir,
    baseUrl,
    notesUrl,
    channel: options.channel,
    publishedAt: options.publishedAt,
  });
  writeManifestFiles({
    manifest,
    outDir,
    signingKey: options.signingKey,
    requireSignature: options.requireSignature,
  });

  console.log(`release ${version} ready at ${outDir}`);
  console.log(`manifest ${join(outDir, "latest.json")}`);
}

if (import.meta.main) {
  await runCli(process.argv.slice(2));
}
