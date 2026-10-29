import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import type { DocumentsImageConfig } from "../config/loader";
import { normalizeImage } from "../documents/image";
import type { ProviderRouter } from "../provider/router";
import { ChatRequestSchema } from "../types/schema";
import type { AgentTool } from "./registry";
import { workspaceRoot } from "./workspace";

function computeAspectRatio(width: number, height: number): string {
  if (width <= 0 || height <= 0) return "unknown";
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  const ratioW = width / divisor;
  const ratioH = height / divisor;
  if (ratioW <= 32 && ratioH <= 32) return `${ratioW}:${ratioH}`;
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
  config?: DocumentsImageConfig;
}): AgentTool<typeof InspectImageArgsSchema> {
  const repoRoot = options?.repoRoot ?? globalThis.process.cwd();
  const router = options?.router;
  const imageConfig = options?.config ?? {
    auto_resize: true,
    max_width: 2_000,
    max_height: 2_000,
    max_base64_bytes: 5_242_880,
  };

  return {
    name: "inspect_image",
    description:
      "Inspect and analyze an image from a local file, web URL, or system clipboard. Resizes and compresses the image to the configured limits, then queries the active vision model to describe UI components, extract screenshot text, or verify visual designs.",
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
        const root = workspaceRoot(repoRoot);
        const fullPath = isAbsolute(args.imagePath) ? args.imagePath : resolve(root, args.imagePath);
        const file = Bun.file(fullPath);
        if (!(await file.exists())) {
          throw new Error(`Image file not found: ${args.imagePath}`);
        }
        imageBytes = new Uint8Array(await file.arrayBuffer());
      } else {
        throw new Error("No image source provided.");
      }

      const normalized = await normalizeImage(imageBytes, imageConfig);
      const base64Data = Buffer.from(normalized.bytes).toString("base64");
      const description = await callVisionProvider({
        router,
        base64Data,
        mimeType: normalized.mimeType,
        prompt: args.prompt,
        detail: args.detail,
      });

      const format = normalized.mimeType.split("/")[1]?.toUpperCase() ?? "IMAGE";
      const resizeNote = normalized.resized
        ? `, resized from ${normalized.originalWidth}x${normalized.originalHeight} ${normalized.originalFormat.toUpperCase()}`
        : "";
      const sizeNote = normalized.resized
        ? ` (source ${(normalized.originalBytes / 1024).toFixed(1)} KB)`
        : "";
      const metaHeader = [
        `[IMAGE INSPECTION REPORT: ${source.toUpperCase()}]`,
        sourceLocation ? `Source: ${sourceLocation}` : "",
        `Dimensions: ${normalized.width}x${normalized.height} (${computeAspectRatio(normalized.width, normalized.height)}, ${format})${resizeNote}`,
        `Size: ${(normalized.bytes.length / 1024).toFixed(1)} KB${sizeNote}`,
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
