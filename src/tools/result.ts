import { resolve } from "node:path";
import { ToolOutputSchema, type ToolExecutionOutput, type ToolOutcome, type ToolOutput, type ToolStatus } from "../types/tool-output";
import type { Message, ToolResult, ToolResultBlock } from "../types/schema";
import { MAX_TOOL_ARTIFACT_BYTES, MAX_TOOL_IMAGES, MAX_TOOL_IMAGE_BYTES, ToolArtifactStore, imageMediaType, readBoundedArtifact } from "./artifacts";
import { DEFAULT_MAX_BYTES, truncateHead } from "./output-budget";

export class ToolResultError extends Error {
  constructor(readonly output: ToolOutput) {
    super(output.reason ?? output.text ?? output.code ?? "Tool operation failed");
  }
}

export function toolContentText(content: ToolResult["content"]): string {
  return typeof content === "string" ? content : content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

export function toolImageBudget(messages: readonly Message[]): Map<number, number> {
  const candidates = new Map<string, { index: number; bytes: number }>();
  let index = 0;
  for (const message of messages) for (const block of message.content) {
    if (block.type !== "tool_result") continue;
    for (const image of typeof block.content === "string" ? [] : block.content.filter((part) => part.type === "image")) {
      const key = `inline:${image.source.data}`;
      candidates.delete(key); candidates.set(key, { index: index++, bytes: image.source.data.length });
    }
    for (const image of block.outcome?.images ?? []) {
      const key = `artifact:${image.sha256 ?? image.path}`;
      candidates.delete(key); candidates.set(key, { index: index++, bytes: Math.ceil(Math.min(image.size_bytes ?? MAX_TOOL_IMAGE_BYTES, MAX_TOOL_IMAGE_BYTES) / 3) * 4 });
    }
  }
  return new Map([...candidates.values()].slice(-MAX_TOOL_IMAGES).map(({ index, bytes }) => [index, bytes]));
}

export function toolResultText(block: { content: ToolResult["content"]; outcome?: ToolOutcome }): string {
  const outcome = block.outcome;
  return [
    ...(outcome && (outcome.status !== "success" || outcome.reason || outcome.code) ? [`[Tool status: ${outcome.status}${outcome.code ? `; ${outcome.code}` : ""}${outcome.reason ? `; ${outcome.reason}` : ""}]`] : []),
    toolContentText(block.content),
    ...(outcome?.data !== undefined ? [JSON.stringify(outcome.data, null, 2)] : []),
    ...(outcome?.coverage ? [`Coverage: ${JSON.stringify(outcome.coverage)}`] : []),
    ...(outcome?.truncation?.truncated ? [`Truncation: ${JSON.stringify(outcome.truncation)}`] : []),
    ...(outcome?.continuation ? [`Continuation (not executed): ${JSON.stringify(outcome.continuation)}`] : []),
    ...toolResultReferences(outcome),
  ].filter(Boolean).join("\n");
}

export function toolResultReferences(outcome?: ToolOutcome): string[] {
  return [
    ...(outcome?.sources ?? []).map((source) => `Source: ${source.title ? `${source.title} — ` : ""}${source.uri}${source.media_type ? ` (${source.media_type})` : ""}`),
    ...(outcome?.images ?? []).map((image) => `Image artifact: ${image.path}${image.source_uri ? `; source: ${image.source_uri}` : ""}`),
    ...(outcome?.artifacts ?? []).map((artifact) => `Artifact: ${artifact.path}${artifact.title ? ` (${artifact.title})` : ""}${artifact.source_uri ? `; source: ${artifact.source_uri}` : ""}`),
  ];
}

export function toolOutputWithReferences(output?: string, outcome?: ToolOutcome): string | undefined {
  const references = toolResultReferences(outcome).filter((reference) => !output?.includes(reference));
  return [output, ...references].filter(Boolean).join("\n") || undefined;
}

function decodeArtifactData(data: string, maxBytes: number): Uint8Array {
  if (data.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) throw new Error("Invalid or oversized base64 artifact");
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength > maxBytes) throw new Error(`Artifact exceeds ${maxBytes} bytes`);
  return bytes;
}

export function toolStatus(result: Pick<ToolResult, "outcome" | "is_error">): ToolStatus {
  return result.outcome?.status ?? (result.is_error ? "error" : "success");
}
export function toolEventStatus(result: Pick<ToolResult, "outcome" | "is_error">): "ok" | Exclude<ToolStatus, "success"> {
  const status = toolStatus(result);
  return status === "success" ? "ok" : status;
}

export async function normalizeToolOutput(
  id: string, output: ToolExecutionOutput, options: { root: string; store?: ToolArtifactStore; durationMs?: number },
): Promise<ToolResult> {
  const value: ToolOutput = typeof output === "string"
    ? { status: output.length ? "success" : "empty", text: output }
    : ToolOutputSchema.parse(output);
  const { text = "", images: inputs, usage, metadata, ...fields } = value;
  const { artifacts: artifactsInput, ...outcomeFields } = fields;
  const outcome: ToolOutcome = { ...outcomeFields, artifacts: [], images: [] };
  const store = options.store ?? new ToolArtifactStore(options.root);
  const problems: string[] = [];
  for (const artifact of (artifactsInput ?? []).slice(0, 16)) {
    try {
      if (artifact.text !== undefined && Buffer.byteLength(artifact.text) > MAX_TOOL_ARTIFACT_BYTES) throw new Error(`Artifact exceeds ${MAX_TOOL_ARTIFACT_BYTES} bytes`);
      const stored = artifact.path !== undefined ? await store.copy({ ...artifact, path: artifact.path }, options.root)
        : await store.put(artifact.text !== undefined ? Buffer.from(artifact.text) : decodeArtifactData(artifact.data!, MAX_TOOL_ARTIFACT_BYTES), artifact.media_type, artifact.title);
      outcome.artifacts!.push({ ...stored, ...(artifact.source_uri ? { source_uri: artifact.source_uri } : {}) });
    }
    catch (error) { problems.push(`Artifact unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if ((artifactsInput?.length ?? 0) > 16) problems.push("Only the first 16 artifacts were retained.");
  for (const input of (inputs ?? []).slice(0, MAX_TOOL_IMAGES)) {
    try {
      let bytes: Uint8Array;
      if (input.path) bytes = await readBoundedArtifact(resolve(options.root, input.path), MAX_TOOL_IMAGE_BYTES);
      else {
        const data = input.data!;
        if (data.length > Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) throw new Error("Invalid or oversized base64 image");
        bytes = Buffer.from(data, "base64");
      }
      if (bytes.byteLength > MAX_TOOL_IMAGE_BYTES || imageMediaType(bytes) !== input.media_type) throw new Error("Image type or size does not match the declared format");
      outcome.images!.push({ ...await store.put(bytes, input.media_type, input.title), ...(input.source_uri ? { source_uri: input.source_uri } : {}) });
    } catch (error) { problems.push(`Image unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if ((inputs?.length ?? 0) > MAX_TOOL_IMAGES) problems.push(`Only the first ${MAX_TOOL_IMAGES} images were retained.`);
  if (outcome.images!.length === 0) delete outcome.images;
  if (outcome.artifacts!.length === 0) delete outcome.artifacts;
  if (problems.length) {
    if (outcome.status === "success" || outcome.status === "empty") outcome.status = "partial";
    outcome.reason = [outcome.reason, ...problems].filter(Boolean).join(" ");
  }
  if ((outcome.coverage?.complete === false || outcome.truncation?.truncated) && outcome.status === "success") outcome.status = "partial";
  const result: ToolResult = {
    tool_call_id: id, content: text, outcome,
    is_error: ["error", "cancelled", "unavailable"].includes(outcome.status),
    metadata: { ...(options.durationMs !== undefined ? { duration_ms: options.durationMs } : {}), ...(usage ? { usage } : {}),
      ...(metadata && Buffer.byteLength(JSON.stringify(metadata)) <= 16 * 1024 ? { ui: metadata } : {}) },
  };
  const projected = toolResultText(result);
  if (Buffer.byteLength(projected) > DEFAULT_MAX_BYTES) {
    let artifact;
    try { artifact = await store.put(Buffer.from(projected), "text/plain", "Full tool result"); } catch { /* The bounded preview remains available if storage fails. */ }
    result.outcome = {
      status: ["error", "cancelled", "unavailable"].includes(outcome.status) ? outcome.status : "partial",
      code: outcome.code?.slice(0, 128), reason: [outcome.reason?.slice(0, 512), "Tool result exceeded the inline payload limit."].filter(Boolean).join(" "),
      ...(outcome.coverage && Buffer.byteLength(JSON.stringify(outcome.coverage)) < 4096 ? { coverage: outcome.coverage } : {}),
      truncation: { truncated: true, original_bytes: Buffer.byteLength(projected) },
      ...(artifact ? { artifacts: [artifact], continuation: { message: "Read the full result artifact if needed.", tool: "read_file", arguments: { filePath: artifact.path } } } : {}),
      ...(outcome.images ? { images: outcome.images } : {}),
    };
    if (Buffer.byteLength(toolResultText({ content: "", outcome: result.outcome })) > DEFAULT_MAX_BYTES / 2) {
      delete result.outcome.images;
      if (result.outcome.continuation) delete result.outcome.continuation.arguments;
    }
    const overhead = Buffer.byteLength(toolResultText({ content: "", outcome: result.outcome })) + 1024;
    result.content = truncateHead(text || projected, { maxBytes: Math.max(1, DEFAULT_MAX_BYTES - overhead) }).text;
    result.outcome.truncation!.returned_bytes = Buffer.byteLength(result.content);
  }
  return result;
}

export function resultBlock(result: ToolResult): ToolResultBlock {
  return {
    type: "tool_result", tool_use_id: result.tool_call_id, content: toolContentText(result.content), is_error: result.is_error,
    ...(result.outcome ? { outcome: result.outcome } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
}

export function pruneToolResult(block: ToolResultBlock, content: string): ToolResultBlock {
  if (!block.outcome) return { ...block, content };
  const { data: _data, images: _images, sources: _sources, continuation: _continuation, coverage: _coverage, ...outcome } = block.outcome;
  return { ...block, content, outcome: { ...outcome, status: block.is_error ? outcome.status : "partial", truncation: { truncated: true, reason: "context pruning" } } };
}
