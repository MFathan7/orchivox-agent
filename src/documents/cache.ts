import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

function cacheDirectory(): string {
  const cacheHome =
    process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(cacheHome, "orchivox", "documents");
}

/**
 * Writes a full document extract to a private cache file. The model receives
 * the path and a preview, then uses grep or read_file for the rest.
 */
export async function writeDocumentCache(
  sourcePath: string,
  kind: string,
  text: string,
): Promise<string> {
  const directory = cacheDirectory();
  await mkdir(directory, { recursive: true });
  const hash = createHash("sha256")
    .update(`${sourcePath}\0${kind}\0${text}`)
    .digest("hex")
    .slice(0, 12);
  const safeName =
    basename(sourcePath)
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, 48) || "document";
  const target = join(directory, `${safeName}-${hash}.txt`);
  await writeFile(target, text, { encoding: "utf8", mode: 0o600 });
  return target;
}
