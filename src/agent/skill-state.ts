import { createHash } from "node:crypto";
import { realpath, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { Message, ToolCall } from "../types/schema";
import { formatLine, splitLines } from "../tools/hashline-edit";
import type { SkillDocument } from "./skills";

export const skillHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const skillSourceKey = (source: { path: string; version?: string }): string => `${source.path}\0${source.version ?? ""}`;

export async function skillSourceVersion(path: string, raw?: string): Promise<string> {
  const source = raw ?? await readFile(path, "utf8");
  let sidecar: string | null = null;
  if (basename(path) === "SKILL.md") {
    try { sidecar = await readFile(join(dirname(path), "agents", "openai.yaml"), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") sidecar = `[unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}]`;
    }
  }
  return skillHash(JSON.stringify([source, sidecar]));
}

const EvidenceSchema = z.object({
  id: z.string(), path: z.string(), sourceHash: z.string(), version: z.string(),
  toolCallId: z.string(), inputHash: z.string(), outputHash: z.string(),
  method: z.enum(["skill", "read_file"]),
  start: z.number().int().positive(), end: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(), invoked: z.boolean(),
});
export type SkillEvidence = z.infer<typeof EvidenceSchema>;
export const SkillLoadSchema = z.object({
  id: z.string(), path: z.string(), sourceHash: z.string(), version: z.string(),
  loadedAt: z.number(), messageIds: z.array(z.string()).min(1), invoked: z.boolean(),
});
export type SkillLoad = z.infer<typeof SkillLoadSchema>;

export function completeSkillOutput(document: SkillDocument, output: string): boolean {
  return output.includes(`<skill_source version="${document.version}" />`) &&
    output.includes(`<skill_body>\n${document.body.trim()}\n</skill_body>`) &&
    output.includes("</skill_content>");
}

export async function recordSkillEvidence(
  message: Message, call: ToolCall, documents: readonly SkillDocument[], root: string,
  invoked: (document: SkillDocument) => boolean,
): Promise<void> {
  const result = message.content.find((block) => block.type === "tool_result" && block.tool_use_id === call.id);
  if (!result || result.type !== "tool_result" || result.is_error || typeof result.content !== "string") return;
  const output = result.content;
  let document: SkillDocument | undefined;
  let start = 1, end = 0, total = 0;
  if (call.name === "skill") {
    document = documents.find((doc) => (doc.id ?? doc.name).toLowerCase() === String(call.arguments.id ?? call.arguments.name).toLowerCase());
    if (!document || !completeSkillOutput(document, output)) return;
    end = total = 1;
  } else if (call.name === "read_file" && typeof call.arguments.filePath === "string") {
    let path: string;
    try { path = await realpath(resolve(root, call.arguments.filePath)); } catch { return; }
    document = documents.find((doc) => doc.path === path);
    if (!document?.sourceText) return;
    const lines = splitLines(document.sourceText);
    start = typeof call.arguments.offset === "number" ? call.arguments.offset : 1;
    const limit = typeof call.arguments.limit === "number" ? call.arguments.limit : 2000;
    total = lines.length;
    const rows = output.split("\n");
    while (end < limit && start + end <= total && rows[end] === formatLine(start + end, lines[start + end - 1]!)) end++;
    if (end === 0) return;
    end += start - 1;
    // A file changed between discovery and execution is not evidence for the old version.
    try { if (await skillSourceVersion(path) !== document.version) return; } catch { return; }
  } else return;
  if (!document.sourceHash || !document.version) return;
  const evidence: SkillEvidence = {
    id: document.id ?? document.name, path: document.path, sourceHash: document.sourceHash,
    version: document.version, toolCallId: call.id, inputHash: skillHash(JSON.stringify(call.arguments)), outputHash: skillHash(output),
    method: call.name as "skill" | "read_file", start, end, total, invoked: invoked(document),
  };
  message.metadata = { ...message.metadata, skillLoads: [evidence] };
}

type SkillSource = Pick<SkillDocument, "id" | "name" | "path" | "sourceHash" | "version">;

export function recordedSkillLoads(messages: readonly Message[]): SkillLoad[] {
  const sources = new Map<string, SkillSource>();
  for (const message of messages) {
    const parsed = z.array(EvidenceSchema).safeParse(message.metadata?.skillLoads);
    if (!parsed.success) continue;
    for (const entry of parsed.data) sources.set(entry.path, { ...entry, name: entry.id });
  }
  return visibleSkillLoads(messages, [...sources.values()]);
}

export function visibleSkillLoads(messages: readonly Message[], documents: readonly SkillSource[]): SkillLoad[] {
  const sources = new Map(documents.map((doc) => [doc.path, doc]));
  const groups = new Map<string, Array<{ evidence: SkillEvidence; message: Message }>>();
  const calls = new Map(messages.flatMap((message) => message.content.flatMap((block) => block.type === "tool_use" ? [[block.id, block] as const] : [])));
  for (const message of messages) {
    const parsed = z.array(EvidenceSchema).safeParse(message.metadata?.skillLoads);
    if (!parsed.success) continue;
    for (const evidence of parsed.data) {
      const document = sources.get(evidence.path);
      const call = calls.get(evidence.toolCallId);
      if (!document || document.version !== evidence.version || document.sourceHash !== evidence.sourceHash ||
        !call || call.name !== evidence.method || skillHash(JSON.stringify(call.input)) !== evidence.inputHash) continue;
      const result = message.content.find((block) => block.type === "tool_result" && block.tool_use_id === evidence.toolCallId);
      if (!result || result.type !== "tool_result" || result.is_error || typeof result.content !== "string" || skillHash(result.content) !== evidence.outputHash) continue;
      const key = `${evidence.path}\0${evidence.version}\0${evidence.method}`;
      const entries = groups.get(key) ?? [];
      entries.push({ evidence, message });
      groups.set(key, entries);
    }
  }
  const loads = new Map<string, SkillLoad>();
  for (const entries of groups.values()) {
    entries.sort((a, b) => a.evidence.start - b.evidence.start);
    let end = 0;
    const used: typeof entries = [];
    for (const entry of entries) {
      if (entry.evidence.start > end + 1) break;
      if (entry.evidence.end > end) { end = entry.evidence.end; used.push(entry); }
    }
    const first = entries[0]!.evidence;
    if (end < first.total || used.length === 0) continue;
    const document = sources.get(first.path)!;
    loads.set(first.path, {
      id: document.id ?? document.name, path: first.path, sourceHash: first.sourceHash, version: first.version,
      loadedAt: Math.max(...used.map(({ message }) => message.created_at ?? 0)),
      messageIds: used.map(({ message }) => message.id), invoked: entries.some(({ evidence }) => evidence.invoked) || loads.get(first.path)?.invoked === true,
    });
  }
  return [...loads.values()];
}
