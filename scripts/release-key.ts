#!/usr/bin/env bun
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DEFAULT_PRIVATE_KEY = join(homedir(), ".config", "orchivox", "release-private.pem");
const DEFAULT_PUBLIC_KEY = "release-public-key.pem";

const HELP_TEXT = [
  "usage:",
  "  bun run scripts/release-key.ts generate [--private <path>] [--public <path>] [--force]",
  "  bun run scripts/release-key.ts public [--private <path>] [--out <path>]",
  "",
  "The private key stays on your machine. Add its base64 value to the",
  "ORCHIVOX_RELEASE_SIGNING_KEY GitHub secret. Commit only the public key.",
].join("\n");

export interface KeyOptions {
  privatePath: string;
  publicPath: string;
  force: boolean;
  out?: string;
}

export function parseKeyArgs(argv: string[]): { command: "generate" | "public" | "help"; options: KeyOptions } {
  const command = argv[0] ?? "help";
  if (command === "-h" || command === "--help") {
    return { command: "help", options: {} as KeyOptions };
  }
  if (command !== "generate" && command !== "public") {
    throw new Error(`unknown command: ${command}`);
  }

  const options: KeyOptions = {
    privatePath: DEFAULT_PRIVATE_KEY,
    publicPath: DEFAULT_PUBLIC_KEY,
    force: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--private") {
      const value = argv[++index];
      if (!value) throw new Error("--private requires a path");
      options.privatePath = value;
    } else if (arg === "--public") {
      const value = argv[++index];
      if (!value) throw new Error("--public requires a path");
      options.publicPath = value;
    } else if (arg === "--out") {
      const value = argv[++index];
      if (!value) throw new Error("--out requires a path");
      options.out = value;
    } else if (arg === "--force") {
      options.force = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { command, options };
}

export function publicKeyPem(privateKeyPem: string): string {
  const privateKey = createPrivateKey({ key: privateKeyPem, format: "pem", type: "pkcs8" });
  return createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
}

export function publicKeyFingerprint(publicPem: string): string {
  const der = createPublicKey(publicPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

export function generateReleaseKeyPair(options: KeyOptions): { privatePath: string; publicPath: string; fingerprint: string } {
  if (!options.force) {
    for (const path of [options.privatePath, options.publicPath]) {
      if (existsSync(path)) {
        throw new Error(`${path} already exists; pass --force to overwrite`);
      }
    }
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  mkdirSync(dirname(resolve(options.privatePath)), { recursive: true, mode: 0o700 });
  writeFileSync(options.privatePath, privatePem, { mode: 0o600 });
  chmodSync(options.privatePath, 0o600);

  mkdirSync(dirname(resolve(options.publicPath)), { recursive: true });
  writeFileSync(options.publicPath, publicPem, "utf8");

  return {
    privatePath: options.privatePath,
    publicPath: options.publicPath,
    fingerprint: publicKeyFingerprint(publicPem),
  };
}

export function runReleaseKeyCli(argv: string[]): void {
  const { command, options } = parseKeyArgs(argv);
  if (command === "help") {
    console.log(HELP_TEXT);
    return;
  }

  if (command === "generate") {
    const result = generateReleaseKeyPair(options);
    console.log(`private key ${result.privatePath} (mode 0600, never commit)`);
    console.log(`public key  ${result.publicPath}`);
    console.log(`fingerprint ${result.fingerprint}`);
    console.log("");
    console.log("Add the private key to GitHub Actions:");
    console.log(
      `  base64 < ${result.privatePath} | tr -d '\\n' | gh secret set ORCHIVOX_RELEASE_SIGNING_KEY`,
    );
    console.log("Commit only the public key.");
    return;
  }

  if (!existsSync(options.privatePath)) {
    throw new Error(`private key not found: ${options.privatePath}`);
  }
  const pem = publicKeyPem(readFileSync(options.privatePath, "utf8"));
  if (options.out) {
    mkdirSync(dirname(resolve(options.out)), { recursive: true });
    writeFileSync(options.out, pem, "utf8");
    console.log(`public key ${options.out}`);
  } else {
    process.stdout.write(pem);
  }
}

if (import.meta.main) {
  runReleaseKeyCli(process.argv.slice(2));
}
