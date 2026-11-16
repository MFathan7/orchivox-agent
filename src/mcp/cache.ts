import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { McpServerConfig } from "../config/loader";
import { ToolOutputSchema, type ToolOutput } from "../types/tool-output";

export const McpToolInfoSchema = z.object({
  name: z.string().min(1), description: z.string().optional(), inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(), execution: z.object({ taskSupport: z.string().optional() }).optional(),
});
export type McpToolInfo = z.infer<typeof McpToolInfoSchema>;
const CacheSchema = z.object({
  format: z.literal(1), identity: z.string(), server: z.object({ name: z.string(), version: z.string() }),
  fingerprint: z.string(), capabilities: z.object({ tools: z.boolean(), resources: z.boolean(), prompts: z.boolean() }),
  tools: z.array(McpToolInfoSchema), capturedAt: z.number(),
  pages: z.record(z.string(), z.object({ capturedAt: z.number(), output: ToolOutputSchema.pick({ status: true, text: true, data: true, sources: true, coverage: true, continuation: true, reason: true, code: true }) })),
});
export type McpCacheRecord = z.infer<typeof CacheSchema>;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;

export function catalogHash(value: unknown): string {
  const canonical = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(canonical) : entry && typeof entry === "object"
    ? Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : entry;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function mcpCacheIdentity(scope: string, name: string, config: McpServerConfig): string {
  return catalogHash([scope, name, config.transport, config.url, config.command, config.args, config.env, config.headers, config.oauth]);
}
export class McpCatalogCache {
  private readonly records = new Map<string, McpCacheRecord>();
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly directory?: string) {}
  get(identity: string) { return this.records.get(identity); }
  async load(identity: string): Promise<McpCacheRecord | undefined> {
    if (this.records.has(identity) || !this.directory) return this.records.get(identity);
    try {
      const file = Bun.file(join(this.directory, `${identity}.json`)); if (file.size > MAX_CACHE_BYTES) return undefined;
      const record = CacheSchema.parse(await file.json());
      if (record.identity !== identity) return undefined;
      if (!this.records.has(identity)) this.records.set(identity, record);
      return this.records.get(identity);
    } catch { return undefined; }
  }
  set(record: McpCacheRecord): void {
    const text = JSON.stringify(record); if (Buffer.byteLength(text) > MAX_CACHE_BYTES) return;
    this.records.set(record.identity, record);
    if (!this.directory) return;
    const previous = this.writes.get(record.identity) ?? Promise.resolve();
    const writing = previous.then(async () => {
      await mkdir(this.directory!, { recursive: true, mode: 0o700 });
      const path = join(this.directory!, `${record.identity}.json`), temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try { await writeFile(temporary, text, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
    }).catch(() => {});
    this.writes.set(record.identity, writing);
  }
  async flush() { await Promise.all(this.writes.values()); }
}
