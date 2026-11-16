import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { resolveProjectState } from "../runtime-paths";
import type { ToolArtifact } from "../types/tool-output";

export const MAX_TOOL_ARTIFACT_BYTES = 50 * 1024 * 1024;
export const MAX_TOOL_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOOL_IMAGES = 4;
const EXTENSIONS: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
  "text/plain": ".txt", "application/json": ".json",
};

export class ToolArtifactStore {
  readonly directory: string;
  constructor(root: string, directory?: string) {
    this.directory = directory ? resolve(root, directory) : join(resolveProjectState(root).dataDir, "tool-artifacts");
  }

  async put(bytes: Uint8Array, mediaType = "application/octet-stream", title?: string): Promise<ToolArtifact> {
    if (bytes.byteLength > MAX_TOOL_ARTIFACT_BYTES) throw new Error(`Artifact exceeds ${MAX_TOOL_ARTIFACT_BYTES} bytes`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(this.directory, `${sha256}${EXTENSIONS[mediaType] ?? ".bin"}`);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(temporary, bytes, { mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    return { path, sha256, size_bytes: bytes.byteLength, media_type: mediaType, ...(title ? { title } : {}) };
  }

  async copy(artifact: ToolArtifact, root: string, maxBytes = MAX_TOOL_ARTIFACT_BYTES): Promise<ToolArtifact> {
    const path = resolve(root, artifact.path);
    const bytes = await readBoundedArtifact(path, maxBytes, artifact.sha256);
    return this.put(bytes, artifact.media_type, artifact.title ?? basename(path));
  }
}

export async function readBoundedArtifact(path: string, maxBytes: number, sha256?: string): Promise<Uint8Array> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Artifact source is not a regular file");
  if (info.size > maxBytes) throw new Error(`Artifact exceeds ${maxBytes} bytes`);
  const file = Bun.file(path);
  const bytes = new Uint8Array(await file.slice(0, maxBytes + 1).arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`Artifact exceeds ${maxBytes} bytes`);
  if (sha256 && createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Artifact content changed");
  return bytes;
}

export function imageMediaType(bytes: Uint8Array): string | undefined {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString())) return "image/gif";
  if (buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return undefined;
}
