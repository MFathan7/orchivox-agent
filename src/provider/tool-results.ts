import type { ChatRequest, ImageBlock, ToolResultBlock } from "../types/schema";
import { MAX_TOOL_IMAGES, MAX_TOOL_IMAGE_BYTES, imageMediaType, readBoundedArtifact } from "../tools/artifacts";
import { toolContentText, toolImageBudget } from "../tools/result";

export function toolResultImages(content: ToolResultBlock["content"]): ImageBlock[] {
  return typeof content === "string" ? [] : content.filter((block): block is ImageBlock => block.type === "image");
}

export function withoutToolImages(req: ChatRequest): ChatRequest {
  return { ...req, messages: req.messages.map((message) => ({ ...message, content: message.content.map((block) => {
    if (block.type !== "tool_result" || !toolResultImages(block.content).length) return block;
    return { ...block, content: `${toolContentText(block.content)}\n[Image not delivered: active model has no vision support.]`.trim() };
  }) })) };
}

export async function prepareToolResults(req: ChatRequest, vision: boolean, signal?: AbortSignal): Promise<ChatRequest> {
  const selected = toolImageBudget(req.messages);
  let delivered = 0, imageIndex = 0;
  const messages = [];
  for (const message of req.messages) {
    const content = [];
    for (const block of message.content) {
      if (block.type !== "tool_result") { content.push(block); continue; }
      const images = toolResultImages(block.content);
      const notes: string[] = [];
      const retained: ImageBlock[] = [];
      for (const image of images) {
        const chosen = selected.has(imageIndex++);
        if (vision && chosen && delivered < MAX_TOOL_IMAGES && image.source.data.length <= Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4) {
          retained.push(image); delivered++;
        } else notes.push("[Image not delivered: vision is unavailable or the image payload limit was reached.]");
      }
      for (const artifact of block.outcome?.images ?? []) {
        const chosen = selected.has(imageIndex++);
        signal?.throwIfAborted();
        if (!vision || !chosen || delivered >= MAX_TOOL_IMAGES) {
          notes.push(`[Image not delivered: ${vision ? "request image limit reached" : "active model has no vision support"}; artifact: ${artifact.path}]`);
          continue;
        }
        try {
          if (!artifact.sha256 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("image reference has no verified content hash");
          const bytes = await readBoundedArtifact(artifact.path, MAX_TOOL_IMAGE_BYTES, artifact.sha256);
          if (imageMediaType(bytes) !== artifact.media_type) throw new Error("image format does not match its reference");
          retained.push({ type: "image", path: artifact.path, source: { type: "base64", media_type: artifact.media_type!, data: Buffer.from(bytes).toString("base64") } });
          delivered++;
        } catch (error) {
          notes.push(`[Image not delivered: ${error instanceof Error ? error.message : String(error)}; artifact: ${artifact.path}]`);
        }
      }
      if (!images.length && !block.outcome?.images?.length) { content.push(block); continue; }
      const text = [toolContentText(block.content), ...notes].filter(Boolean).join("\n");
      content.push({ ...block, content: retained.length ? [{ type: "text" as const, text }, ...retained] : text });
    }
    messages.push({ ...message, content });
  }
  return { ...req, messages };
}
