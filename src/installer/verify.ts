import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import { InstallerError } from "./types";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function verifySha256(path: string, expected: string): Promise<void> {
  const actual = await sha256File(path);
  if (actual !== expected.toLowerCase()) {
    throw new InstallerError(
      "checksum_mismatch",
      `Checksum mismatch for ${path}: expected ${expected}, got ${actual}.`,
    );
  }
}
