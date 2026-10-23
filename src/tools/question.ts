import { z } from "zod";

import type { AgentTool } from "./registry";

export const QuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});

/** The request the UI receives after the model input has been normalized. */
export const QuestionRequestSchema = z.object({
  question: z.string().min(1),
  header: z.string().optional(),
  options: z.array(QuestionOptionSchema).min(1).max(8),
  multiple: z.boolean().default(false),
  allow_custom: z.boolean().default(true),
  /**
   * The options are agent modes. Answering with plan, build, or ultrawork
   * switches the session mode, so only set this for a mode handoff.
   */
  mode_options: z.boolean().default(false),
});

export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;

const RawOptionSchema = z.union([
  z.string(),
  z
    .object({
      label: z.string().optional(),
      text: z.string().optional(),
      title: z.string().optional(),
      value: z.string().optional(),
      description: z.string().optional(),
    })
    .passthrough(),
]);

const OptionsFieldSchema = z.union([z.array(RawOptionSchema), z.string()]).optional();

/**
 * Models copy the question shape from other clients: options under label,
 * choices, or a JSON string. Accept those so the choice still reaches the user
 * instead of failing validation.
 */
export const QuestionArgumentsSchema = z
  .object({
    question: z.string().optional(),
    prompt: z.string().optional(),
    text: z.string().optional(),
    title: z.string().optional(),
    header: z.string().optional(),
    options: OptionsFieldSchema,
    choices: OptionsFieldSchema,
    labels: OptionsFieldSchema,
    label: OptionsFieldSchema,
    multiple: z.boolean().default(false),
    allow_custom: z.boolean().default(true),
    mode_options: z.boolean().default(false),
  })
  .passthrough();

export type QuestionArguments = z.infer<typeof QuestionArgumentsSchema>;

export const QUESTION_UNSHOWN =
  "The question could not be shown in this client. Continue without an answer: make a reasonable assumption and state it, or ask the user directly in your reply.";

function parseOptionsField(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to line splitting
    }
  }
  return trimmed
    .split(/\r?\n|;/)
    .map((entry) => entry.replace(/^\s*(?:\d+[.)]|[-*+])\s+/, "").trim())
    .filter((entry) => entry.length > 0);
}

function labelOf(option: unknown): QuestionRequest["options"][number] | undefined {
  if (typeof option === "string") {
    const label = option.trim();
    return label.length > 0 ? { label } : undefined;
  }
  if (!option || typeof option !== "object" || Array.isArray(option)) return undefined;
  const record = option as Record<string, unknown>;
  const label = [record.label, record.text, record.title, record.value].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!label) return undefined;
  const description =
    typeof record.description === "string" && record.description.trim().length > 0
      ? record.description.trim()
      : undefined;
  return { label: label.trim(), ...(description ? { description } : {}) };
}

export function normalizeQuestionArguments(
  args: QuestionArguments,
): QuestionRequest | undefined {
  const question =
    args.question ?? args.prompt ?? args.text ?? args.title ?? args.header ?? "";
  const rawOptions = args.options ?? args.choices ?? args.labels ?? args.label;
  const seen = new Set<string>();
  const options: QuestionRequest["options"] = [];
  for (const raw of parseOptionsField(rawOptions)) {
    const option = labelOf(raw);
    if (!option || seen.has(option.label)) continue;
    seen.add(option.label);
    options.push(option);
    if (options.length === 8) break;
  }
  const text = question.trim();
  if (text.length === 0 || options.length === 0) return undefined;
  const header =
    args.header && args.header.trim().length > 0 && args.header.trim() !== text
      ? args.header.trim()
      : undefined;
  return {
    question: text,
    ...(header ? { header } : {}),
    options: options.length >= 2 ? options : [...options, { label: "OK" }],
    multiple: args.multiple,
    allow_custom: args.allow_custom,
    mode_options: args.mode_options,
  };
}

export const QuestionAnswerSchema = z.object({
  selected: z.array(z.string()).default([]),
  custom: z.string().optional(),
  cancelled: z.boolean().default(false),
});

export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

export type QuestionHandler = (
  request: QuestionRequest & { id: string },
) => Promise<QuestionAnswer>;

export function createQuestionTool(
  handler: QuestionHandler,
): AgentTool<typeof QuestionArgumentsSchema> {
  return {
    name: "question",
    description:
      "Ask the user a question when a requirement or choice is ambiguous. Provide 2 to 8 options, each with a label and optional description. Set multiple=true to allow more than one answer. The user may type a custom answer. Set mode_options=true only when the options are agent modes (plan, build, ultrawork); the answer then switches the session mode. Do not use this for approval of risky actions; the approval flow handles that.",
    parameters: QuestionArgumentsSchema,
    readOnly: true,
    async execute(args) {
      const request = normalizeQuestionArguments(args);
      if (!request) return QUESTION_UNSHOWN;
      const id = `question-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const answer = await handler({ ...request, id });
      if (answer.cancelled) return "User cancelled the question.";
      const parts: string[] = [];
      if (answer.selected.length > 0) {
        parts.push(`Selected: ${answer.selected.join(", ")}`);
      }
      const custom = answer.custom?.trim();
      if (custom) parts.push(`Custom answer: ${custom}`);
      return parts.length > 0 ? parts.join("\n") : "User did not select an option.";
    },
  };
}
