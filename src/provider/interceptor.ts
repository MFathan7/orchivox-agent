import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { ConfigError } from "../config/loader";
import type { ChatRequest, Message, StreamEvent } from "../types/schema";
import type { LLMProvider } from "./router";

export const STREAM_RULES_PATH = ".agent/rules/stream_rules.yaml";

export const StreamRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  appliesToGlob: z.string().min(1),
  triggerRegex: z.string().min(1),
  action: z.literal("abort_and_retry"),
  reminderMessage: z.string().min(1),
});
export type StreamRule = z.infer<typeof StreamRuleSchema>;

export async function loadStreamRules(path: string = STREAM_RULES_PATH): Promise<StreamRule[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  let raw: unknown;
  try {
    raw = parseYaml(await file.text());
  } catch (error) {
    throw new ConfigError(`Failed to parse YAML in ${path}: ${errorMessage(error)}`, path);
  }
  const result = z.array(StreamRuleSchema).safeParse(raw ?? []);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
    throw new ConfigError(`Invalid stream rules in ${path}`, path, issues);
  }
  return result.data;
}

interface CompiledRule {
  rule: StreamRule;
  pattern: RegExp;
  glob: Bun.Glob;
}

interface RuleViolation {
  entry: CompiledRule;
  matchStart: number;
}

export interface InterceptedProviderOptions {
  rules: StreamRule[];
  maxRetries?: number;
}

export class InterceptedProvider implements LLMProvider {
  private readonly inner: LLMProvider;
  private readonly compiled: CompiledRule[];
  private readonly maxRetries: number;

  constructor(inner: LLMProvider, options: InterceptedProviderOptions) {
    this.inner = inner;
    this.compiled = options.rules.map(compileRule);
    this.maxRetries = options.maxRetries ?? 3;
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown> {
    const active = this.compiled.filter((entry) => matchesTarget(entry, req.target_path));
    if (active.length === 0) {
      yield* this.inner.streamChat(req, signal);
      return;
    }

    let request = req;
    const injected = new Set<string>();
    let outputChars = 0;
    let attempt = 0;

    while (true) {
      attempt += 1;
      const controller = new AbortController();
      const relayAbort = (): void => controller.abort(signal?.reason);
      signal?.addEventListener("abort", relayAbort, { once: true });

      let buffer = "";
      let violation: RuleViolation | undefined;

      try {
        for await (const event of this.inner.streamChat(request, controller.signal)) {
          if (violation) continue;
          if (event.type !== "token" && event.type !== "tool_call_delta") {
            yield event;
            continue;
          }
          const fragment = event.type === "token" ? event.text : event.arguments_delta;
          const fragmentStart = buffer.length;
          buffer += fragment;
          outputChars += fragment.length;
          const match = findViolation(active, buffer);
          if (!match) {
            yield event;
            continue;
          }
          violation = match;
          controller.abort();
          const safeLength = Math.max(0, match.matchStart - fragmentStart);
          if (safeLength > 0) {
            const safeFragment = fragment.slice(0, safeLength);
            yield event.type === "token"
              ? { type: "token", text: safeFragment }
              : { ...event, arguments_delta: safeFragment };
          }
          yield ruleViolationEvent(match, outputChars);
        }
      } catch (error) {
        if (!violation) {
          if (signal?.aborted) {
            yield { type: "done", finish_reason: "aborted" };
          } else {
            yield { type: "error", code: "stream_failed", message: errorMessage(error), recoverable: true };
            yield { type: "done", finish_reason: "error" };
          }
          return;
        }
      } finally {
        signal?.removeEventListener("abort", relayAbort);
      }

      if (!violation) return;

      if (attempt > this.maxRetries) {
        yield { type: "done", finish_reason: "error" };
        return;
      }
      request = withReminder(request, violation, injected);
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    return this.inner.listModels(signal);
  }
}

function compileRule(rule: StreamRule): CompiledRule {
  let pattern: RegExp;
  try {
    pattern = new RegExp(rule.triggerRegex);
  } catch (error) {
    throw new Error(`stream rule "${rule.id}" has an invalid triggerRegex: ${errorMessage(error)}`);
  }
  return { rule, pattern, glob: new Bun.Glob(rule.appliesToGlob) };
}

function matchesTarget(entry: CompiledRule, targetPath: string | undefined): boolean {
  const target = targetPath ?? "";
  return entry.glob.match(target) || entry.glob.match(target.split(/[\\/]/).pop() ?? target);
}

function findViolation(entries: readonly CompiledRule[], buffer: string): RuleViolation | undefined {
  let found: RuleViolation | undefined;
  for (const entry of entries) {
    const match = entry.pattern.exec(buffer);
    if (match && (!found || match.index < found.matchStart)) {
      found = { entry, matchStart: match.index };
    }
  }
  return found;
}

function ruleViolationEvent(violation: RuleViolation, outputEnd: number): StreamEvent {
  // A retry regenerates the whole answer, so every output char delivered so far is invalidated: consumers rewind to span.start.
  return {
    type: "rule_violation",
    rule: violation.entry.rule.id,
    message: violation.entry.rule.reminderMessage,
    severity: "block",
    span: { start: 0, end: outputEnd },
  };
}

function withReminder(request: ChatRequest, violation: RuleViolation, injected: Set<string>): ChatRequest {
  const messages: Message[] = [...request.messages];
  const ruleId = violation.entry.rule.id;
  if (!injected.has(ruleId)) {
    injected.add(ruleId);
    messages.push({
      id: `stream-interceptor-${ruleId}`,
      role: "user",
      content: [
        {
          type: "text",
          text: `[SYSTEM STREAM INTERCEPTOR - RULE VIOLATION]: ${violation.entry.rule.reminderMessage}. Repeat your answer without violating this rule.`,
        },
      ],
    });
  }
  return { ...request, messages };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
