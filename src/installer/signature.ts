import { createPublicKey, verify } from "node:crypto";

import { RELEASE_PUBLIC_KEY_PEM } from "./release-public-key";
import { InstallerError } from "./types";

export function resolveReleasePublicKey(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ORCHIVOX_RELEASE_PUBLIC_KEY?.trim();
  if (!override) return RELEASE_PUBLIC_KEY_PEM;
  if (override.includes("BEGIN PUBLIC KEY")) return override;
  return Buffer.from(override, "base64").toString("utf8");
}

export function verifyManifestSignature(
  manifest: Buffer | Uint8Array | string,
  signature: Buffer | Uint8Array | string,
  publicKeyPem: string = RELEASE_PUBLIC_KEY_PEM,
): void {
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch (error) {
    throw new InstallerError(
      "signature_invalid",
      `Release public key is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const signatureBytes =
    typeof signature === "string"
      ? Buffer.from(signature.trim(), "base64")
      : Buffer.from(signature);
  const manifestBytes =
    typeof manifest === "string" ? Buffer.from(manifest) : Buffer.from(manifest);

  if (!verify(null, manifestBytes, key, signatureBytes)) {
    throw new InstallerError(
      "signature_invalid",
      "Release manifest signature is invalid.",
    );
  }
}
