const INTERNAL_BLOCKS = [
  /<skill_content\b[\s\S]*?<\/skill_content>/gi,
  /<skill_files\b[\s\S]*?<\/skill_files>/gi,
  /<available_skills\b[\s\S]*?<\/available_skills>/gi,
  /<file\b[\s\S]*?<\/file>/gi,
];

const INTERNAL_TAGS =
  /<\/?(?:skill_content|skill_files|available_skills|file|name|path|content)\b[^>]*>/gi;

const INTERNAL_DUMP_PATTERNS = [
  /<skill_content\b/i,
  /<skill_files\b/i,
  /<available_skills\b/i,
  /<file\b/i,
  /Gate Check Response/i,
  /Hard Gate \(Block 1\)/i,
  /Purpose-Gate/i,
  /Anti-Slop Design Gate System/i,
  /Gate 1: Hard Gate/i,
  /Quick Pass Criteria/i,
];

export function looksLikeInternalDump(text: string): boolean {
  return INTERNAL_DUMP_PATTERNS.some((pattern) => pattern.test(text));
}

export function sanitizeAssistantText(text: string): string {
  let cleaned = text;
  for (const pattern of INTERNAL_BLOCKS) {
    cleaned = cleaned.replace(pattern, "");
  }
  cleaned = cleaned.replace(INTERNAL_TAGS, "");
  cleaned = cleaned
    .replace(/\n{4,}/g, "\n\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return cleaned;
}
