import { z } from "zod";
import { ToolOutputSchema, type ToolOutput } from "../types/tool-output";

export const McpToolResultEnvelopeSchema = z.object({
  content: z.array(z.unknown()).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
}).passthrough();

interface McpOutputOptions {
  server?: string;
  tool?: string;
  validateStructured?: (value: unknown) => { valid: boolean; errorMessage?: string };
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  const a = Object.keys(left).sort(), b = Object.keys(right).sort();
  return a.length === b.length && a.every((key, index) => key === b[index] && sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

export function mcpToolOutput(value: unknown, options: McpOutputOptions = {}): ToolOutput {
  const envelope = McpToolResultEnvelopeSchema.safeParse(value);
  if (!envelope.success) return { status: "error", code: "mcp_invalid_result", reason: "MCP server returned a malformed tool result." };
  const result = envelope.data;
  if (result.content === undefined && result.structuredContent === undefined && "toolResult" in result) return { status: "unavailable", code: "mcp_result_unavailable", reason: "MCP server did not return a synchronous tool result." };
  if (result.content === undefined && result.structuredContent === undefined && !result.isError) return { status: "error", code: "mcp_invalid_result", reason: "MCP result contained no tool content." };
  const output: ToolOutput = { status: result.isError ? "error" : "success", text: "", sources: [], images: [], artifacts: [] };
  if (result.isError) output.code = "mcp_tool_error";
  const text: string[] = [], problems: string[] = [];
  let schemaFailure = false;
  const source = (resource: { uri: string; name?: string; mimeType?: string }) => output.sources!.push({ uri: resource.uri, ...(resource.name ? { title: resource.name } : {}), ...(resource.mimeType ? { media_type: resource.mimeType } : {}) });
  for (const block of result.content ?? []) {
    const part = z.object({ type: z.string().min(1).max(128) }).passthrough().safeParse(block);
    if (!part.success) { problems.push("Invalid MCP content block."); continue; }
    const value = part.data;
    if (value.type === "text" && typeof value.text === "string") text.push(value.text);
    else if (value.type === "image") {
      const image = ToolOutputSchema.shape.images.unwrap().element.safeParse({ data: value.data, media_type: value.mimeType });
      if (image.success) output.images!.push(image.data); else problems.push("Unsupported or malformed MCP image; its visual content was not delivered.");
    } else if (value.type === "resource_link") {
      const resource = z.object({ uri: z.string().min(1), name: z.string().optional(), mimeType: z.string().optional() }).safeParse(value);
      if (resource.success) source(resource.data); else problems.push("Invalid MCP resource link.");
    } else if (value.type === "resource") {
      const resource = z.object({ uri: z.string().min(1), mimeType: z.string().optional(), text: z.string().optional(), blob: z.string().optional() }).safeParse(value.resource);
      if (!resource.success) { problems.push("Invalid MCP embedded resource."); continue; }
      const body = resource.data;
      source(body);
      if (body.text !== undefined) text.push(`Embedded resource: ${body.uri}${body.mimeType ? ` (${body.mimeType})` : ""}\n${body.text}`);
      if (body.blob !== undefined) {
        const image = ToolOutputSchema.shape.images.unwrap().element.safeParse({ data: body.blob, media_type: body.mimeType, source_uri: body.uri });
        if (image.success) output.images!.push(image.data);
        else {
          output.artifacts!.push({ data: body.blob, media_type: body.mimeType ?? "application/octet-stream", source_uri: body.uri, title: "Embedded MCP resource" });
          problems.push("Embedded binary resource retained as an artifact; its body was not delivered as text or an image.");
        }
      } else if (body.text === undefined) problems.push("MCP embedded resource had no text or binary body.");
    } else problems.push(`MCP content type ${value.type} is unsupported; its body was not delivered.`);
  }
  if (result.structuredContent !== undefined) {
    const data = z.record(z.string(), z.json()).safeParse(result.structuredContent);
    if (data.success) output.data = data.data;
    else { problems.push("Invalid MCP structured content; an object was expected."); schemaFailure = true; }
  }
  if (options.validateStructured && !result.isError) {
    if (output.data === undefined) { schemaFailure = true; problems.push("Tool output schema requires structured content, but none was provided."); }
    else {
      const validated = options.validateStructured(output.data);
      if (!validated.valid) { schemaFailure = true; problems.push(`MCP output schema validation failed: ${validated.errorMessage ?? "invalid structured output"}`); }
    }
  }
  output.text = text.filter((part) => {
    if (output.data === undefined) return true;
    try { return !sameJson(JSON.parse(part), output.data); } catch { return true; }
  }).join("\n");
  if (schemaFailure && !result.isError) { output.status = "error"; output.code = "mcp_output_schema_invalid"; }
  else if (problems.length && !result.isError) output.status = "partial";
  else if (!result.isError && !output.text && output.data === undefined && !output.images!.length && !output.sources!.length && !output.artifacts!.length) output.status = "empty";
  if (problems.length) output.reason = problems.join(" ");
  if (result.isError && !output.text) output.reason = output.reason ?? "MCP tool reported an error.";
  if (options.server && options.tool) output.sources!.unshift({ uri: `mcp://${encodeURIComponent(options.server)}/tools/${encodeURIComponent(options.tool)}`, title: "MCP tool result" });
  if (!output.images!.length) delete output.images;
  if (!output.artifacts!.length) delete output.artifacts;
  if (!output.sources!.length) delete output.sources;
  return output;
}
