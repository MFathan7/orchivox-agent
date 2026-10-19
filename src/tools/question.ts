import { z } from "zod";

import type { AgentTool } from "./registry";

export const QuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});

export const QuestionRequestSchema = z.object({
  question: z.string().min(1),
  header: z.string().optional(),
  options: z.array(QuestionOptionSchema).min(2).max(8),
  multiple: z.boolean().default(false),
  allow_custom: z.boolean().default(true),
});

export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;

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
): AgentTool<typeof QuestionRequestSchema> {
  return {
    name: "question",
    description:
      "Ask the user a question when a requirement or choice is ambiguous. Provide 2 to 8 options. Set multiple=true to allow more than one answer. The user may type a custom answer. Do not use this for approval of risky actions; the approval flow handles that.",
    parameters: QuestionRequestSchema,
    readOnly: true,
    async execute(args) {
      const id = `question-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const answer = await handler({ ...args, id });
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
