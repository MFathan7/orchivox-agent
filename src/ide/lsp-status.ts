import { ToolResultError } from "../tools/result";

export type LspFailureKind = "not_ready" | "server_exited" | "timeout" | "cancelled" | "unsupported" | "protocol_error" | "invalid_response";

export class LspFailure extends ToolResultError {
  constructor(readonly kind: LspFailureKind, readonly method: string, message: string) {
    super({
      status: kind === "cancelled" ? "cancelled" : ["not_ready", "server_exited", "unsupported"].includes(kind) ? "unavailable" : "error",
      code: `lsp_${kind}`, text: message, reason: message,
      sources: [{ uri: `lsp:${method}`, title: "Language server" }],
    });
    this.name = "LspFailure";
  }
}

export function lspFailure(error: unknown, method: string, signal?: AbortSignal): LspFailure {
  if (signal?.aborted) return new LspFailure("cancelled", method, `Language server request cancelled: ${method}`);
  if (error instanceof LspFailure) return error;
  if (error instanceof Error && error.name === "AbortError") return new LspFailure("cancelled", method, `Language server request cancelled: ${method}`);
  return new LspFailure("protocol_error", method, error instanceof Error ? error.message : String(error));
}
