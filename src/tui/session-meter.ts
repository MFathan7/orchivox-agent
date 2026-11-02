import type { CompactionEvent, ContextEstimateEvent } from "../types/schema";

/** The live meter fields that describe the current request, not the session. */
export interface ContextMeter {
  contextTokens: number;
  contextRequestBytes: number;
  contextInputBudget: number;
  contextBufferTokens: number;
  maxRequestBytes: number;
}

export function applyContextEstimate(meter: ContextMeter, event: ContextEstimateEvent): void {
  meter.contextTokens = event.tokens;
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
  if (event.request_bytes !== undefined) meter.contextRequestBytes = event.request_bytes;
  if (event.input_budget !== undefined) meter.contextInputBudget = event.input_budget;
  if (event.buffer_tokens !== undefined) meter.contextBufferTokens = event.buffer_tokens;
  if (event.max_request_bytes !== undefined) meter.maxRequestBytes = event.max_request_bytes;
}
