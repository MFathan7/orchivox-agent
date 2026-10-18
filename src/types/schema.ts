import { z } from "zod";

export const RoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type Role = z.infer<typeof RoleSchema>;

export const ModelRoleSchema = z.enum(["main_model", "fast_model", "advisor_model"]);
export type ModelRole = z.infer<typeof ModelRoleSchema>;

export const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

export const ImageBlockSchema = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.string().min(1),
    data: z.string().min(1),
  }),
  path: z.string().min(1).optional(),
  detail: z.enum(["auto", "low", "high"]).optional(),
});
export type ImageBlock = z.infer<typeof ImageBlockSchema>;

export const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;

export const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(TextBlockSchema)]),
  is_error: z.boolean().default(false),
});
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;

export const ThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;

export const ContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ImageBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ThinkingBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  role: RoleSchema,
  content: z.array(ContentBlockSchema),
  model: z.string().min(1).optional(),
  created_at: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const JsonSchemaObjectSchema = z.record(z.string(), z.unknown());
export type JsonSchemaObject = z.infer<typeof JsonSchemaObjectSchema>;

const isZodSchema = (value: unknown): value is z.ZodType =>
  value instanceof z.ZodType ||
  (typeof value === "object" &&
    value !== null &&
    typeof (value as { parse?: unknown }).parse === "function" &&
    typeof (value as { safeParse?: unknown }).safeParse === "function");

export const ZodSchemaLikeSchema = z.custom<z.ZodType>(isZodSchema, {
  message: "expected a Zod schema",
});

export const ToolParametersSchema = z.union([ZodSchemaLikeSchema, JsonSchemaObjectSchema]);
export type ToolParameters = z.infer<typeof ToolParametersSchema>;

export const ToolDefinitionSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "must be alphanumeric with dashes or underscores"),
  description: z.string().min(1),
  parameters: ToolParametersSchema,
  strict: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export function toolParametersToJsonSchema(parameters: ToolParameters): JsonSchemaObject {
  if (!isZodSchema(parameters)) return parameters;
  return z.toJSONSchema(parameters, { target: "draft-7", io: "input" }) as JsonSchemaObject;
}

export const ChatRequestSchema = z.object({
  model: z.string().min(1).optional(),
  target_path: z.string().min(1).optional(),
  system: z.string().optional(),
  messages: z.array(MessageSchema).min(1),
  tools: z.array(ToolDefinitionSchema).default([]),
  tool_choice: z.enum(["auto", "none", "required"]).default("auto"),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive(),
  stop_sequences: z.array(z.string().min(1)).default([]),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultSchema = z.object({
  tool_call_id: z.string().min(1),
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
  is_error: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const TokenPricingSchema = z.object({
  input_usd_per_million_tokens: z.number().nonnegative(),
  output_usd_per_million_tokens: z.number().nonnegative(),
});
export type TokenPricing = z.infer<typeof TokenPricingSchema>;

export const UsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().default(0),
  cache_creation_input_tokens: z.number().int().nonnegative().default(0),
});
export type Usage = z.infer<typeof UsageSchema>;

export function computeCostUsd(
  promptTokens: number,
  completionTokens: number,
  pricing: TokenPricing | undefined,
): number | undefined {
  if (!pricing) return undefined;
  const cost =
    (promptTokens / 1_000_000) * pricing.input_usd_per_million_tokens +
    (completionTokens / 1_000_000) * pricing.output_usd_per_million_tokens;
  return Math.round(cost * 10_000_000) / 10_000_000;
}

export const TokenEventSchema = z.object({
  type: z.literal("token"),
  text: z.string(),
  message_index: z.number().int().nonnegative().optional(),
});
export type TokenEvent = z.infer<typeof TokenEventSchema>;

export const ThinkingTokenEventSchema = z.object({
  type: z.literal("thinking_token"),
  text: z.string(),
  signature: z.string().optional(),
});
export type ThinkingTokenEvent = z.infer<typeof ThinkingTokenEventSchema>;

export const ToolCallDeltaEventSchema = z.object({
  type: z.literal("tool_call_delta"),
  id: z.string().min(1),
  index: z.number().int().nonnegative(),
  name_delta: z.string().default(""),
  arguments_delta: z.string().default(""),
});
export type ToolCallDeltaEvent = z.infer<typeof ToolCallDeltaEventSchema>;

export const ToolCallReadyEventSchema = z.object({
  type: z.literal("tool_call_ready"),
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
export type ToolCallReadyEvent = z.infer<typeof ToolCallReadyEventSchema>;

export const UsageEventSchema = UsageSchema.extend({
  type: z.literal("usage"),
});
export type UsageEvent = z.infer<typeof UsageEventSchema>;

export const RuleViolationEventSchema = z.object({
  type: z.literal("rule_violation"),
  rule: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(["warning", "error", "block"]),
  span: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .optional(),
  replacement: z.string().optional(),
});
export type RuleViolationEvent = z.infer<typeof RuleViolationEventSchema>;

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  code: z.string().min(1),
  message: z.string().min(1),
  recoverable: z.boolean().default(false),
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

export const DoneEventSchema = z.object({
  type: z.literal("done"),
  finish_reason: z.enum(["stop", "length", "tool_calls", "content_filter", "refusal", "aborted", "error"]),
  usage: UsageSchema.optional(),
});
export type DoneEvent = z.infer<typeof DoneEventSchema>;
export type FinishReason = DoneEvent["finish_reason"];

export const ReasoningEffortSchema = z.enum(["off", "low", "medium", "high", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ApprovalChoiceSchema = z.enum([
  "approve_once",
  "approve_session",
  "deny",
  "deny_with_feedback",
]);
export type ApprovalChoice = z.infer<typeof ApprovalChoiceSchema>;

export const DiffPreviewDetailsSchema = z.object({
  filePath: z.string().min(1),
  oldText: z.string(),
  newText: z.string(),
  oldLabel: z.string().optional(),
  newLabel: z.string().optional(),
});
export type DiffPreviewDetails = z.infer<typeof DiffPreviewDetailsSchema>;

export const ShellRiskDetailsSchema = z.object({
  command: z.string(),
  cwd: z.string(),
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  warning: z.string().optional(),
});
export type ShellRiskDetails = z.infer<typeof ShellRiskDetailsSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  mode: z.enum(["plan", "build", "ultrawork"]),
  readOnly: z.boolean(),
  filePath: z.string().optional(),
  diffPreview: DiffPreviewDetailsSchema.optional(),
  shellDetails: ShellRiskDetailsSchema.optional(),
  reason: z.string().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z.object({
  approved: z.boolean(),
  choice: ApprovalChoiceSchema,
  feedback: z.string().optional(),
  reason: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const EditHunkSchema = z.object({
  startAnchor: z.string().min(1),
  endAnchor: z.string().min(1),
  newContent: z.string(),
});
export type EditHunk = z.infer<typeof EditHunkSchema>;

export const MultiHunkEditSchema = z.object({
  filePath: z.string().min(1),
  edits: z.array(EditHunkSchema).optional(),
  startAnchor: z.string().optional(),
  endAnchor: z.string().optional(),
  newContent: z.string().optional(),
});
export type MultiHunkEdit = z.infer<typeof MultiHunkEditSchema>;

export const SpecialistAgentProfileSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  systemPrompt: z.string().min(1),
  modelRole: ModelRoleSchema.default("main_model"),
  thinkingBudget: z.number().int().nonnegative().default(0),
  allowedTools: z.array(z.string().min(1)).optional(),
  readOnlyOnly: z.boolean().default(false),
  color: z.string().optional(),
});
export type SpecialistAgentProfile = z.infer<typeof SpecialistAgentProfileSchema>;

export const CustomCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  template: z.string(),
  sourceFile: z.string().optional(),
  argumentCount: z.number().int().nonnegative().default(0),
});
export type CustomCommand = z.infer<typeof CustomCommandSchema>;

export const ApprovalRequiredEventSchema = z.object({
  type: z.literal("approval_required"),
  request: ApprovalRequestSchema,
});
export type ApprovalRequiredEvent = z.infer<typeof ApprovalRequiredEventSchema>;

export const AdvisorNoteEventSchema = z.object({
  type: z.literal("advisor_note"),
  note: z.string(),
  severity: z.enum(["info", "warning", "critical"]).default("info"),
});
export type AdvisorNoteEvent = z.infer<typeof AdvisorNoteEventSchema>;

export const BgProcessUpdateEventSchema = z.object({
  type: z.literal("bg_process_update"),
  processId: z.string().min(1),
  status: z.enum(["running", "ready", "stopped", "failed"]),
  listeningUrls: z.array(z.string()).default([]),
  recentLogLine: z.string().optional(),
});
export type BgProcessUpdateEvent = z.infer<typeof BgProcessUpdateEventSchema>;

export const ToolStartEventSchema = z.object({
  type: z.literal("tool_start"),
  id: z.string().min(1),
  name: z.string().min(1),
  arguments_summary: z.string().default(""),
  file_path: z.string().optional(),
});
export type ToolStartEvent = z.infer<typeof ToolStartEventSchema>;

export const ToolEndEventSchema = z.object({
  type: z.literal("tool_end"),
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["ok", "error"]),
  duration_ms: z.number().nonnegative().default(0),
  file_path: z.string().optional(),
});
export type ToolEndEvent = z.infer<typeof ToolEndEventSchema>;

export const FileChangeEventSchema = z.object({
  type: z.literal("file_change"),
  path: z.string().min(1),
  old_text: z.string(),
  new_text: z.string(),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
});
export type FileChangeEvent = z.infer<typeof FileChangeEventSchema>;

export const SkillActivatedEventSchema = z.object({
  type: z.literal("skill_activated"),
  name: z.string().min(1),
  allowed_tools: z.array(z.string()).default([]),
});
export type SkillActivatedEvent = z.infer<typeof SkillActivatedEventSchema>;

export const StreamEventSchema = z.discriminatedUnion("type", [
  TokenEventSchema,
  ThinkingTokenEventSchema,
  ToolCallDeltaEventSchema,
  ToolCallReadyEventSchema,
  UsageEventSchema,
  RuleViolationEventSchema,
  ErrorEventSchema,
  DoneEventSchema,
  ApprovalRequiredEventSchema,
  AdvisorNoteEventSchema,
  BgProcessUpdateEventSchema,
  ToolStartEventSchema,
  ToolEndEventSchema,
  FileChangeEventSchema,
  SkillActivatedEventSchema,
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const AgentModeSchema = z.enum(["plan", "build", "ultrawork"]);
export type AgentMode = z.infer<typeof AgentModeSchema>;

export const WorktreeIsolationSchema = z.object({
  enabled: z.boolean().default(true),
  base_ref: z.string().min(1).default("HEAD"),
  branch_prefix: z.string().min(1).default("orchivox/subagent"),
  keep_on_failure: z.boolean().default(false),
});
export type WorktreeIsolation = z.infer<typeof WorktreeIsolationSchema>;

export const SubagentSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  task: z.string().min(1),
  mode: AgentModeSchema.default("build"),
  model_role: ModelRoleSchema.default("main_model"),
  tools: z.array(z.string().min(1)).default([]),
  worktree: WorktreeIsolationSchema.prefault({}),
  max_turns: z.number().int().positive().default(24),
  timeout_ms: z.number().int().positive().default(600_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type SubagentSpec = z.infer<typeof SubagentSpecSchema>;

export const SubagentStateSchema = z.enum([
  "queued",
  "preparing",
  "running",
  "finalizing",
  "completed",
  "failed",
  "aborted",
  "timed_out",
]);
export type SubagentState = z.infer<typeof SubagentStateSchema>;

export const SubagentStatusSchema = z.object({
  id: z.string().min(1),
  state: SubagentStateSchema,
  turns_used: z.number().int().nonnegative().default(0),
  worktree_path: z.string().optional(),
  branch: z.string().optional(),
  started_at: z.number().int().nonnegative().optional(),
  updated_at: z.number().int().nonnegative().optional(),
  detail: z.string().optional(),
});
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

export const SubagentResultSchema = z.object({
  id: z.string().min(1),
  state: z.enum(["completed", "failed", "aborted", "timed_out"]),
  output: z.string(),
  diff: z.string().optional(),
  files_changed: z.array(z.string()).default([]),
  commits: z.array(z.string()).default([]),
  branch: z.string().optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string(),
    })
    .optional(),
  usage: UsageSchema.optional(),
  started_at: z.number().int().nonnegative().optional(),
  finished_at: z.number().int().nonnegative().optional(),
});
export type SubagentResult = z.infer<typeof SubagentResultSchema>;

export const TodoStatusSchema = z.enum(["pending", "in_progress", "completed", "cancelled"]);
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

export const TodoPrioritySchema = z.enum(["low", "medium", "high", "critical"]);
export type TodoPriority = z.infer<typeof TodoPrioritySchema>;

export const TodoItemSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  status: TodoStatusSchema.default("pending"),
  priority: TodoPrioritySchema.default("medium"),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;
