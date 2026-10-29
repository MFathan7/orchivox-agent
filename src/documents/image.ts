import type { DocumentsImageConfig } from "../config/loader";
import { DocumentReadError } from "./types";

export interface NormalizedImage {
  bytes: Uint8Array;
  mimeType: string;
  base64Bytes: number;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  originalBytes: number;
  originalFormat: string;
  resized: boolean;
}

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function mimeFor(format: string): string {
  return format === "jpg" ? "image/jpeg" : `image/${format}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function normalizeImage(
  bytes: Uint8Array,
  config: DocumentsImageConfig,
): Promise<NormalizedImage> {
  const maxPixels = Math.max(16_777_216, config.max_width * config.max_height * 4);
  let metadata: { width: number; height: number; format: string };
  try {
    metadata = await new Bun.Image(bytes, { maxPixels }).metadata();
  } catch (error) {
    throw new DocumentReadError(`Could not decode the image: ${errorMessage(error)}`, "invalid");
  }

  const originalBase64 = base64Length(bytes.length);
  const withinDimensions =
    metadata.width <= config.max_width && metadata.height <= config.max_height;
  const withinBase64 = originalBase64 <= config.max_base64_bytes;
  if (withinDimensions && withinBase64) {
    return {
      bytes,
      mimeType: mimeFor(metadata.format),
      base64Bytes: originalBase64,
      width: metadata.width,
      height: metadata.height,
      originalWidth: metadata.width,
      originalHeight: metadata.height,
      originalBytes: bytes.length,
      originalFormat: metadata.format,
      resized: false,
    };
  }

  if (!config.auto_resize) {
    throw new DocumentReadError(
      `Image is ${metadata.width}x${metadata.height} (${bytes.length} bytes), above the configured limits. Enable documents.image.auto_resize or resize it first.`,
      "too_large",
    );
  }

  let scale = 1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const targetWidth = Math.max(
      1,
      Math.min(config.max_width, Math.round(metadata.width * scale)),
    );
    const targetHeight = Math.max(
      1,
      Math.min(config.max_height, Math.round(metadata.height * scale)),
    );
    const formats: Array<{ mimeType: string; encode: (image: Bun.Image) => Bun.Image }> = [
      { mimeType: "image/webp", encode: (image) => image.webp({ quality: 82 }) },
      { mimeType: "image/jpeg", encode: (image) => image.jpeg({ quality: 82 }) },
      { mimeType: "image/png", encode: (image) => image.png({ compressionLevel: 9 }) },
    ];

    for (const format of formats) {
      try {
        const pipeline = new Bun.Image(bytes, { maxPixels }).resize(
          targetWidth,
          targetHeight,
          { fit: "inside", withoutEnlargement: true },
        );
        const encoded = await format.encode(pipeline).bytes();
        const encodedBase64 = base64Length(encoded.length);
        if (encodedBase64 > config.max_base64_bytes) continue;
        const output = await new Bun.Image(encoded).metadata().catch(() => undefined);
        return {
          bytes: encoded,
          mimeType: format.mimeType,
          base64Bytes: encodedBase64,
          width: output?.width ?? targetWidth,
          height: output?.height ?? targetHeight,
          originalWidth: metadata.width,
          originalHeight: metadata.height,
          originalBytes: bytes.length,
          originalFormat: metadata.format,
          resized: true,
        };
      } catch {
        // Try the next output format or a smaller scale.
      }
    }
    scale *= 0.75;
  }

  throw new DocumentReadError(
    "Image is still above the configured limits after resizing. Reduce documents.image.max_width, max_height, or max_base64_bytes.",
    "too_large",
  );
}
