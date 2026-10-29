import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { InstallerError, type DownloadProgress } from "./types";

export interface DownloadOptions {
  url: string;
  destination: string;
  expectedSha256: string;
  expectedSize?: number;
  onProgress?: (progress: DownloadProgress) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  sha256: string;
}

export async function downloadToFile(options: DownloadOptions): Promise<DownloadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const hash = createHash("sha256");
  const started = performance.now();
  let received = 0;
  let file: Awaited<ReturnType<typeof open>> | undefined;

  await mkdir(dirname(options.destination), { recursive: true, mode: 0o700 });

  try {
    const response = await fetchImpl(options.url, {
      headers: {
        "user-agent": "orchivox-installer",
        accept: "application/octet-stream",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new InstallerError(
        "download_failed",
        `Download failed (${response.status} ${response.statusText}): ${options.url}`,
      );
    }
    if (!response.body) {
      throw new InstallerError("download_failed", `Download returned an empty body: ${options.url}`);
    }

    const headerSize = Number(response.headers.get("content-length"));
    const total = options.expectedSize ?? (Number.isFinite(headerSize) ? headerSize : 0);
    file = await open(options.destination, "w", 0o600);
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      hash.update(value);
      received += value.byteLength;
      await writeAll(file, value);

      const elapsedSeconds = (performance.now() - started) / 1000;
      const bytesPerSecond = elapsedSeconds > 0 ? received / elapsedSeconds : 0;
      options.onProgress?.({
        received,
        total,
        percent: total > 0 ? Math.min(100, (received / total) * 100) : 0,
        bytesPerSecond,
        etaSeconds: bytesPerSecond > 0 && total > received ? (total - received) / bytesPerSecond : 0,
      });
    }

    await file.close();
    file = undefined;

    if (total > 0 && received !== total) {
      throw new InstallerError(
        "download_incomplete",
        `Download incomplete: expected ${total} bytes, received ${received}.`,
      );
    }

    const actual = hash.digest("hex");
    if (actual !== options.expectedSha256.toLowerCase()) {
      throw new InstallerError(
        "checksum_mismatch",
        `Checksum mismatch: expected ${options.expectedSha256}, got ${actual}.`,
      );
    }

    return { path: options.destination, bytes: received, sha256: actual };
  } catch (error) {
    await file?.close().catch(() => undefined);
    await rm(options.destination, { force: true }).catch(() => undefined);
    if (options.signal?.aborted) {
      throw new InstallerError("cancelled", "Installation cancelled.");
    }
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(
      "download_failed",
      `Download failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    options.signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
  }
}

async function writeAll(
  file: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten === 0) {
      throw new InstallerError("download_failed", "Could not write downloaded data.");
    }
    offset += bytesWritten;
  }
}
