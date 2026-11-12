import type { CompactionEvent, ContextEstimateEvent, Usage } from "../types/schema";

/** The live meter fields that describe the current request, not the session. */
export interface ContextMeter {
  contextTokens: number;
  contextRequestBytes: number;
  contextInputBudget: number;
  contextBufferTokens: number;
  maxRequestBytes: number;
  contextSource?: "reported" | "estimated";
}

export function finishContextMeter(meter: ContextMeter, updated: boolean, estimate: () => number): void {
  if (updated) return;
  meter.contextTokens = estimate();
  meter.contextSource = "estimated";
}

export function applyUsageContext(meter: ContextMeter, usage: Usage): void {
  if (usage.prompt_tokens > 0) {
    meter.contextTokens = usage.prompt_tokens + usage.completion_tokens;
    meter.contextSource = "reported";
  } else {
    meter.contextTokens += usage.completion_tokens;
    meter.contextSource = "estimated";
  }
}

export function applyContextEstimate(meter: ContextMeter, event: ContextEstimateEvent): void {
  meter.contextTokens = event.tokens;
  meter.contextSource = "estimated";
  meter.contextRequestBytes = event.request_bytes;
  meter.contextInputBudget = event.input_budget;
  meter.contextBufferTokens = event.buffer_tokens;
  meter.maxRequestBytes = event.max_request_bytes;
}

/**
 * Compaction replaces the current context. It must not touch session spend or
 * the session token total, which keep accumulating across compactions.
 */
export function applyCompactionMeter(meter: ContextMeter, event: CompactionEvent): void {
  meter.contextTokens = event.after_tokens;
  meter.contextSource = "estimated";
  if (event.request_bytes !== undefined) meter.contextRequestBytes = event.request_bytes;
  if (event.input_budget !== undefined) meter.contextInputBudget = event.input_budget;
  if (event.buffer_tokens !== undefined) meter.contextBufferTokens = event.buffer_tokens;
  if (event.max_request_bytes !== undefined) meter.maxRequestBytes = event.max_request_bytes;
}
