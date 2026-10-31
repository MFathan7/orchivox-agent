import { isRetryableProviderError } from "./retry";

export type ProviderFailureKind =
  | "overflow"
  | "output_budget"
  | "unsupported_params"
  | "retryable"
  | "other";

const PAYLOAD_TOO_LARGE =
  /request entity too large|payload too large|request body too large|entity too large|body too large|content too large|(?<![a-z0-9])413(?![a-z0-9])/i;

const CONTEXT_OVERFLOW =
  /context length|context_length_exceeded|too many tokens|maximum context|prompt is too long|reduce the length of the messages|request too large|input length|input token count|maximum number of tokens|tokens? exceed|exceed(?:s|ed)? the (?:model'?s )?(?:maximum|limit)|exceeds? the context|over the context limit/i;

const OUTPUT_BUDGET =
  /requested\s+\d+\s+output tokens|output tokens?.*(?:too large|exceed)|max_tokens.*(?:too large|exceed)/i;

const UNSUPPORTED_PARAMS =
  /UnsupportedParamsError|does not support (?:the )?(?:parameter|parameters|param|params)|unsupported (?:parameter|parameters|param|params)/i;

export function providerHttpCode(status: number): string {
  return `http_${status}`;
}

export function isPayloadTooLargeError(message: string, code?: string): boolean {
  if (code === "http_413" || code === "413") return true;
  return PAYLOAD_TOO_LARGE.test(message);
}

export function isContextOverflowError(message: string, code?: string): boolean {
  return isPayloadTooLargeError(message, code) || CONTEXT_OVERFLOW.test(message);
}

export function isOutputBudgetError(message: string): boolean {
  return OUTPUT_BUDGET.test(message);
}

export function isUnsupportedParamsError(message: string): boolean {
  return UNSUPPORTED_PARAMS.test(message);
}

export function classifyProviderFailure(
  message: string,
  code?: string,
  status?: number,
): ProviderFailureKind {
  if (isContextOverflowError(message, code)) return "overflow";
  if (isOutputBudgetError(message)) return "output_budget";
  if (isUnsupportedParamsError(message)) return "unsupported_params";
  if (isRetryableProviderError(message, status)) return "retryable";
  return "other";
}
