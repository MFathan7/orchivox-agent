/**
 * Parses a model's structured output. Models often wrap JSON in a Markdown
 * fence even when the prompt asks for raw JSON, so accept both forms.
 */
export function parseStructuredJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("structured output was empty");

  const candidates: string[] = [trimmed];
  for (const match of trimmed.matchAll(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g)) {
    const content = (match[1] ?? "").trim();
    if (content.length > 0) candidates.push(content);
  }

  const extracted = extractFirstJsonValue(trimmed);
  if (extracted) candidates.push(extracted);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("response did not contain a valid JSON value");
}

function extractFirstJsonValue(text: string): string | undefined {
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === open) {
      depth += 1;
      continue;
    }
    if (character === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}
