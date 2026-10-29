/**
 * Some local models print a tool call as JSON text instead of using the
 * provider tool channel. Recovering it keeps the turn alive, but only when the
 * whole message is one call for a tool this turn actually offers.
 */
export interface TextToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

const FENCE = /```(?:json|javascript|js|tool_call)?[ \t]*\r?\n?([\s\S]*?)```/gi;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function nameOf(value: Record<string, unknown>): string | undefined {
  const fn = asRecord(value.function);
  const raw = fn ? fn.name : (value.name ?? value.tool ?? value.tool_name);
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function argumentsOf(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const fn = asRecord(value.function);
  const raw = fn
    ? (fn.arguments ?? fn.parameters)
    : (value.arguments ?? value.args ?? value.parameters ?? value.input);
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "string") return parseJsonObject(raw);
  return asRecord(raw);
}

export function parseTextToolCall(
  text: string,
  allowedNames: readonly string[],
): TextToolCall | undefined {
  const stripped = text.replace(/<\/?tool_call>/gi, "").trim();
  const fenced: string[] = [];
  const rest = stripped
    .replace(FENCE, (_match, body: string) => {
      fenced.push(body);
      return "";
    })
    .trim();
  if (fenced.length > 0 && rest.length > 0) return undefined;

  const candidates = fenced.length > 0 ? fenced : [stripped];
  const allowed = new Set(allowedNames);
  for (const candidate of candidates) {
    const value = parseJsonObject(candidate);
    if (!value) continue;
    const name = nameOf(value);
    if (!name || !allowed.has(name)) continue;
    const args = argumentsOf(value);
    if (!args) continue;
    return {
      id: `text-tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      arguments: args,
    };
  }
  return undefined;
}
