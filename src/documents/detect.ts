import { extname } from "node:path";

import type { DocumentKind } from "./types";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function isImage(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) || // PNG
    startsWith(bytes, [0xff, 0xd8, 0xff]) || // JPEG
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) || // GIF
    (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytes.length >= 12 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50) // WebP
  );
}

function isZip(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
}

function isText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (sample.includes(0)) return false;
  try {
    UTF8_DECODER.decode(sample);
    return true;
  } catch {
    return false;
  }
}

export function detectDocumentKind(bytes: Uint8Array, filePath: string): DocumentKind {
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (header.includes("%PDF-")) return "pdf";
  if (isImage(bytes)) return "image";
  if (isZip(bytes)) {
    const extension = extname(filePath).toLowerCase();
    if (extension === ".docx" || extension === ".docm") return "docx";
    if (extension === ".xlsx" || extension === ".xlsm") return "xlsx";
    return "unsupported";
  }
  if (isText(bytes)) return "text";
  return "unsupported";
}
