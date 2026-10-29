import { fromBufferPromise, type ZipFile } from "yauzl";

import { DocumentReadError } from "./types";

export interface ZipInfo {
  entries: string[];
  totalUncompressedBytes: number;
}

export interface ZipLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
}

/**
 * Reads the ZIP central directory without extracting entries. This rejects zip
 * bombs and macro-enabled Office files before a parser allocates their content.
 */
export async function inspectZip(
  bytes: Uint8Array,
  limits: ZipLimits,
): Promise<ZipInfo> {
  let zip: ZipFile;
  try {
    zip = await fromBufferPromise(Buffer.from(bytes), { lazyEntries: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DocumentReadError(`Could not open the Office file: ${message}`, "invalid");
  }

  const entries: string[] = [];
  let totalUncompressedBytes = 0;

  return await new Promise<ZipInfo>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      try {
        zip.close();
      } catch {
        // The ZIP is already closed or invalid.
      }
      reject(error);
    };

    zip.on("entry", (entry) => {
      const name = entry.fileName.toLowerCase();
      entries.push(entry.fileName);
      totalUncompressedBytes += entry.uncompressedSize ?? 0;
      if (name.endsWith("vbaproject.bin")) {
        fail(
          new DocumentReadError(
            "This Office file contains macros. Remove the macros or convert it to a plain DOCX/XLSX file before reading.",
            "unsupported",
          ),
        );
        return;
      }
      if (entries.length > limits.maxEntries) {
        fail(
          new DocumentReadError(
            `The Office file has more than ${limits.maxEntries} ZIP entries.`,
            "too_large",
          ),
        );
        return;
      }
      if (totalUncompressedBytes > limits.maxUncompressedBytes) {
        fail(
          new DocumentReadError(
            `The Office file expands past ${(limits.maxUncompressedBytes / 1024 / 1024).toFixed(0)} MB.`,
            "too_large",
          ),
        );
        return;
      }
      zip.readEntry();
    });
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({ entries, totalUncompressedBytes });
    });
    zip.on("error", (error) => {
      fail(
        error instanceof DocumentReadError
          ? error
          : new DocumentReadError(`Could not inspect the Office file: ${error.message}`, "invalid"),
      );
    });
    zip.readEntry();
  });
}
