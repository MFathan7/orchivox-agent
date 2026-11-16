import { z } from "zod";

export const ToolProgressSchema = z.object({
  progress: z.number().finite().nonnegative(), total: z.number().finite().nonnegative().optional(), message: z.string().max(512).optional(),
});
export type ToolProgress = z.infer<typeof ToolProgressSchema>;

export const ToolStatusSchema = z.enum(["success", "empty", "error", "cancelled", "unavailable", "partial"]);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

const ArtifactPathSchema = z.string().min(1).max(32767).refine((path) => !path.includes("\0") && !/^(?:data:|[a-z][a-z0-9+.-]*:\/\/)/i.test(path), "use a filesystem path rather than a URI");

export const ToolArtifactSchema = z.object({
  path: ArtifactPathSchema,
  title: z.string().max(512).optional(),
  media_type: z.string().max(128).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  source_uri: z.string().min(1).optional(),
});
export type ToolArtifact = z.infer<typeof ToolArtifactSchema>;

const ToolArtifactInputSchema = ToolArtifactSchema.partial({ path: true }).extend({
  data: z.string().optional(),
  text: z.string().optional(),
}).refine((artifact) => [artifact.path, artifact.data, artifact.text].filter((value) => value !== undefined).length === 1, "provide an artifact path, base64 data, or text");

export const ToolUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  cost_incomplete: z.boolean().optional(),
});

export const ToolOutcomeSchema = z.object({
  status: ToolStatusSchema,
  reason: z.string().optional(),
  code: z.string().optional(),
  data: z.json().optional(),
  images: z.array(ToolArtifactSchema).optional(),
  artifacts: z.array(ToolArtifactSchema).optional(),
  sources: z.array(z.object({ uri: z.string().min(1), title: z.string().optional(), media_type: z.string().optional() })).optional(),
  continuation: z.object({
    message: z.string(),
    tool: z.string().optional(),
    arguments: z.record(z.string(), z.json()).optional(),
    cursor: z.json().optional(),
  }).optional(),
  coverage: z.object({
    scope: z.string().optional(), complete: z.boolean().optional(),
    returned: z.number().int().nonnegative().optional(), total: z.number().int().nonnegative().optional(),
    unit: z.string().optional(),
  }).optional(),
  truncation: z.object({
    truncated: z.boolean(), reason: z.string().optional(),
    original_bytes: z.number().int().nonnegative().optional(),
    returned_bytes: z.number().int().nonnegative().optional(),
  }).optional(),
});
export type ToolOutcome = z.infer<typeof ToolOutcomeSchema>;

export const ToolOutputSchema = ToolOutcomeSchema.omit({ images: true, artifacts: true }).extend({
  text: z.string().optional(),
  artifacts: z.array(ToolArtifactInputSchema).optional(),
  images: z.array(z.object({
    path: ArtifactPathSchema.optional(),
    data: z.string().min(1).optional(),
    media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    title: z.string().max(512).optional(),
    source_uri: z.string().min(1).optional(),
  }).refine((image) => Boolean(image.path) !== Boolean(image.data), "provide an image path or base64 data" )).optional(),
  usage: ToolUsageSchema.optional(),
  metadata: z.record(z.string(), z.json()).optional(),
});
export type ToolOutput = z.infer<typeof ToolOutputSchema>;
export type ToolExecutionOutput = string | ToolOutput;

export const ToolHostMetadataSchema = z.object({
  duration_ms: z.number().nonnegative().optional(),
  usage: ToolUsageSchema.optional(),
  ui: z.record(z.string(), z.json()).optional(),
});
