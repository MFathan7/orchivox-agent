import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import type { ProviderRouter } from "../provider/router";
import { ChatRequestSchema } from "../types/schema";
import type { AgentTool } from "./registry";

export interface ImageMetadata {
  width: number;
  height: number;
  mimeType: string;
  format: "png" | "jpeg" | "gif" | "webp" | "unknown";
  byteLength: number;
  aspectRatio: string;
}

export interface VisionAnalysisResult {
  metadata: ImageMetadata;
  description: string;
  source: "file" | "url" | "clipboard";
  sourceLocation?: string;
}

export function parseImageMetadata(bytes: Uint8Array): ImageMetadata | null {
  if (bytes.length < 10) return null;

  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    if (bytes.length < 24) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    return {
      width,
      height,
      mimeType: "image/png",
      format: "png",
      byteLength: bytes.length,
      aspectRatio: computeAspectRatio(width, height),
    };
  }

  // GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    return {
      width,
      height,
      mimeType: "image/gif",
      format: "gif",
      byteLength: bytes.length,
      aspectRatio: computeAspectRatio(width, height),
    };
  }

  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length - 8) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const height = view.getUint16(offset + 5, false);
        const width = view.getUint16(offset + 7, false);
        return {
          width,
          height,
          mimeType: "image/jpeg",
          format: "jpeg",
          byteLength: bytes.length,
          aspectRatio: computeAspectRatio(width, height),
        };
      }
      const len = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (len <= 0) break;
      offset += 2 + len;
    }
  }

  // WebP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunkHeader = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunkHeader === "VP8X" && bytes.length >= 30) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return {
        width,
        height,
        mimeType: "image/webp",
        format: "webp",
        byteLength: bytes.length,
        aspectRatio: computeAspectRatio(width, height),
      };
    }
    if (chunkHeader === "VP8 " && bytes.length >= 30) {
      const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
      const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
      return {
        width,
        height,
        mimeType: "image/webp",
        format: "webp",
        byteLength: bytes.length,
        aspectRatio: computeAspectRatio(width, height),
      };
    }
    if (chunkHeader === "VP8L" && bytes.length >= 25) {
      const b0 = bytes[21];
      const b1 = bytes[22];
      const b2 = bytes[23];
      const b3 = bytes[24];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return {
        width,
        height,
        mimeType: "image/webp",
        format: "webp",
        byteLength: bytes.length,
        aspectRatio: computeAspectRatio(width, height),
      };
    }
  }

  return null;
}

function computeAspectRatio(width: number, height: number): string {
  if (width <= 0 || height <= 0) return "unknown";
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  const ratioW = width / divisor;
  const ratioH = height / divisor;

  if (ratioW <= 32 && ratioH <= 32) {
    return `${ratioW}:${ratioH}`;
  }
  return `${(width / height).toFixed(2)}:1`;
}

export async function grabClipboardImage(): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const isLinux = process.platform === "linux";
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";

  if (isLinux) {
    // Try Wayland wl-paste first
    try {
      const proc = Bun.spawn(["wl-paste", "-t", "image/png"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const buffer = await new Response(proc.stdout).arrayBuffer();
      const exitCode = await proc.exited;
      if (exitCode === 0 && buffer.byteLength > 0) {
        return { bytes: new Uint8Array(buffer), mimeType: "image/png" };
      }
    } catch {
      // Fallback to X11 xclip
    }

    try {
      const proc = Bun.spawn(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const buffer = await new Response(proc.stdout).arrayBuffer();
      const exitCode = await proc.exited;
      if (exitCode === 0 && buffer.byteLength > 0) {
        return { bytes: new Uint8Array(buffer), mimeType: "image/png" };
      }
    } catch {
      // X11 failed
    }
  } else if (isMac) {
    try {
      const proc = Bun.spawn(["pngpaste", "-"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const buffer = await new Response(proc.stdout).arrayBuffer();
      const exitCode = await proc.exited;
      if (exitCode === 0 && buffer.byteLength > 0) {
        return { bytes: new Uint8Array(buffer), mimeType: "image/png" };
      }
    } catch {
      // pngpaste failed
    }
  } else if (isWindows) {
    try {
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        $img = [System.Windows.Forms.Clipboard]::GetImage()
        if ($img) {
          $ms = New-Object System.IO.MemoryStream
          $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
          [Console]::OpenStandardOutput().Write($ms.ToArray(), 0, $ms.Length)
        }
      `;
      const proc = Bun.spawn(["powershell", "-NoProfile", "-Command", psScript], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const buffer = await new Response(proc.stdout).arrayBuffer();
      const exitCode = await proc.exited;
      if (exitCode === 0 && buffer.byteLength > 0) {
        return { bytes: new Uint8Array(buffer), mimeType: "image/png" };
      }
    } catch {
      // Powershell failed
    }
  }

  throw new Error(
    "No image data found on system clipboard or required clipboard tools (wl-paste, xclip, pngpaste) are unavailable.",
  );
}

export async function callVisionProvider(options: {
  router?: ProviderRouter;
  base64Data: string;
  mimeType: string;
  prompt: string;
  detail?: "auto" | "low" | "high";
  signal?: AbortSignal;
}): Promise<string> {
  const { router, base64Data, mimeType, prompt, detail, signal } = options;

  if (!router) {
    return "Image received and verified. No provider router is attached, so visual analysis is unavailable.";
  }

  const candidates: Array<{
    role: "advisor" | "main";
    ref: { provider: string; model: string };
    vision: boolean;
  }> = [];
  for (const role of ["advisor", "main"] as const) {
    const candidateRef = router.getRole(role);
    if (!candidateRef) continue;
    candidates.push({
      role,
      ref: candidateRef,
      vision: router.capabilitiesFor(candidateRef.provider, candidateRef.model).vision,
    });
  }
  if (candidates.length === 0) throw new Error("no configured model found for vision analysis");

  const selected = candidates.find((candidate) => candidate.vision) ?? candidates[0];
  const ref = selected.ref;
  if (!selected.vision) {
    return `The ${selected.role} model ${ref.provider}/${ref.model} does not support vision. Set model_capabilities.vision: true for a vision model or assign one to the advisor role.`;
  }

  const request = ChatRequestSchema.parse({
    messages: [
      {
        id: `vision-${Date.now().toString(36)}`,
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mimeType, data: base64Data },
            ...(detail ? { detail } : {}),
          },
          { type: "text", text: prompt },
        ],
      },
    ],
    max_tokens: 4096,
  });

  const provider = router.provider(ref.provider, ref.model);
  let text = "";
  for await (const event of provider.streamChat(request, signal)) {
    if (event.type === "token") text += event.text;
    else if (event.type === "error") throw new Error(event.message);
  }
  return text.trim().length > 0 ? text.trim() : "The vision model returned no text.";
}

export const InspectImageArgsSchema = z
  .object({
    imagePath: z
      .string()
      .optional()
      .describe("Local file path to an image (.png, .jpg, .jpeg, .webp, .gif)."),
    imageUrl: z.string().url().optional().describe("HTTP/HTTPS URL of an image."),
    fromClipboard: z
      .boolean()
      .default(false)
      .describe("If true, retrieves the image directly from the operating system clipboard."),
    prompt: z
      .string()
      .default("Describe this image in detail, identify UI components, text content, and any visual anomalies or errors.")
      .describe("Instruction for multimodal vision inspection."),
    detail: z
      .enum(["auto", "low", "high"])
      .default("auto")
      .describe("Vision resolution detail level (auto, low, high)."),
  })
  .refine((data) => Boolean(data.imagePath || data.imageUrl || data.fromClipboard), {
    message: "Must provide either imagePath, imageUrl, or fromClipboard: true",
  });
export type InspectImageArgs = z.infer<typeof InspectImageArgsSchema>;

export function createInspectImageTool(options?: {
  router?: ProviderRouter;
  repoRoot?: string;
}): AgentTool<typeof InspectImageArgsSchema> {
  const repoRoot = options?.repoRoot ?? globalThis.process.cwd();
  const router = options?.router;

  return {
    name: "inspect_image",
    description:
      "Inspect and analyze an image from a local file, web URL, or system clipboard. Decodes dimensions and visual properties and queries the active vision model to describe UI components, extract screenshot text, or verify visual designs.",
    parameters: InspectImageArgsSchema,
    readOnly: true,
    async execute(args) {
      let imageBytes: Uint8Array;
      let source: "file" | "url" | "clipboard";
      let sourceLocation: string | undefined;

      if (args.fromClipboard) {
        source = "clipboard";
        const grabbed = await grabClipboardImage();
        imageBytes = grabbed.bytes;
        sourceLocation = "system clipboard";
      } else if (args.imageUrl) {
        source = "url";
        sourceLocation = args.imageUrl;
        const response = await fetch(args.imageUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch image from URL: ${response.status} ${response.statusText}`);
        }
        imageBytes = new Uint8Array(await response.arrayBuffer());
      } else if (args.imagePath) {
        source = "file";
        sourceLocation = args.imagePath;
        const fullPath = isAbsolute(args.imagePath) ? args.imagePath : resolve(repoRoot, args.imagePath);
        const file = Bun.file(fullPath);
        if (!(await file.exists())) {
          throw new Error(`Image file not found: ${args.imagePath}`);
        }
        imageBytes = new Uint8Array(await file.arrayBuffer());
      } else {
        throw new Error("No image source provided.");
      }

      const metadata = parseImageMetadata(imageBytes);
      if (imageBytes.length > 5 * 1024 * 1024) {
        throw new Error("Image is larger than 5 MB; resize it before inspection.");
      }
      const mimeType = metadata?.mimeType ?? "image/png";
      const base64Data = Buffer.from(imageBytes).toString("base64");

      const description = await callVisionProvider({
        router,
        base64Data,
        mimeType,
        prompt: args.prompt,
        detail: args.detail,
      });

      const metaHeader = [
        `[IMAGE INSPECTION REPORT: ${source.toUpperCase()}]`,
        sourceLocation ? `Source: ${sourceLocation}` : "",
        metadata
          ? `Dimensions: ${metadata.width}x${metadata.height} (${metadata.aspectRatio}, ${metadata.format.toUpperCase()})`
          : `MIME: ${mimeType}`,
        `Size: ${(imageBytes.length / 1024).toFixed(1)} KB`,
        "",
        `Analysis Prompt: "${args.prompt}"`,
        "--- Visual Analysis ---",
        description,
      ]
        .filter(Boolean)
        .join("\n");

      return metaHeader;
    },
  };
}
