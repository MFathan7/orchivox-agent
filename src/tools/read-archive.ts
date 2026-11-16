import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { fromBufferPromise, type Entry } from "yauzl";
import { z } from "zod";
import type { AgentTool } from "./registry";
import { truncateHead } from "./output-budget";

const Schema = z.object({ filePath: z.string().min(1), member: z.string().min(1).optional(),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(50) });
const MAX_EXPANDED = 100 * 1024 * 1024;
function safeName(name: string): void {
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.replace(/\\/g, "/").split("/").includes("..")) throw new Error("Archive contains an unsafe member path.");
}
function text(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new Error("Member is binary; this tool only previews UTF-8 text.");
  return truncateHead(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { maxBytes: 40_000 }).text;
}

export function createReadArchiveTool(): AgentTool<typeof Schema> {
  return {
    name: "read_archive", description: "List ZIP-compatible archives (ZIP/JAR/WHL), TAR, or TAR.GZ, or preview one UTF-8 member without extracting to disk. Listings are paginated; compressed/expanded/member sizes are bounded. Other formats are not supported.",
    parameters: Schema, readOnly: true, concurrency: "shared",
    async execute(args, context) {
      context?.signal?.throwIfAborted();
      if (args.member) safeName(args.member);
      const file = Bun.file(args.filePath);
      if (file.size > 25 * 1024 * 1024) throw new Error("Archive exceeds the 25 MiB input limit.");
      const bytes = await file.bytes();
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        const zip = await fromBufferPromise(Buffer.from(bytes), { lazyEntries: true, autoClose: false });
        const entries: Array<{ name: string; bytes: number }> = [];
        let total = 0, member: Entry | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            zip.on("error", reject);
            zip.on("entry", (entry: Entry) => {
              try {
                context?.signal?.throwIfAborted(); safeName(entry.fileName);
                total += entry.uncompressedSize;
                if (entry.generalPurposeBitFlag & 1) throw new Error("Encrypted archive members are not supported.");
                if (entries.length >= 10_000 || total > MAX_EXPANDED) throw new Error("Archive exceeds expanded size or entry limits.");
                entries.push({ name: entry.fileName, bytes: entry.uncompressedSize });
                if (args.member === entry.fileName) member = entry;
                zip.readEntry();
              } catch (error) { reject(error); }
            });
            zip.on("end", resolve); zip.readEntry();
          });
          if (!args.member) return JSON.stringify({ entries: entries.slice(args.offset, args.offset + args.limit), total: entries.length,
            nextOffset: args.offset + args.limit < entries.length ? args.offset + args.limit : undefined });
          if (!member) throw new Error("Archive member not found.");
          if (member.uncompressedSize > 2 * 1024 * 1024) throw new Error("Member exceeds the 2 MiB text preview limit.");
          const stream = await zip.openReadStreamPromise(member);
          const parts: Buffer[] = [];
          let size = 0;
          for await (const chunk of stream) {
            context?.signal?.throwIfAborted(); size += chunk.length;
            if (size > 2 * 1024 * 1024) { stream.destroy(); throw new Error("Member exceeded its read limit."); }
            parts.push(Buffer.from(chunk));
          }
          return text(Buffer.concat(parts));
        } finally { zip.close(); }
      }
      let tar = bytes;
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) tar = new Uint8Array(await promisify(gunzip)(bytes, { maxOutputLength: MAX_EXPANDED }));
      if (tar.length > MAX_EXPANDED) throw new Error("Archive exceeds expanded size limit.");
      const files = await new Bun.Archive(tar).files();
      if (files.size > 10_000) throw new Error("Archive exceeds the entry limit.");
      let total = 0;
      for (const [name, blob] of files) { safeName(name); total += blob.size; }
      if (total > MAX_EXPANDED) throw new Error("Archive exceeds expanded size limit.");
      context?.signal?.throwIfAborted();
      if (args.member) {
        const blob = files.get(args.member);
        if (!blob) throw new Error("Archive member not found.");
        if (blob.size > 2 * 1024 * 1024) throw new Error("Member exceeds the 2 MiB text preview limit.");
        return text(await blob.bytes());
      }
      const entries = [...files].map(([name, blob]) => ({ name, bytes: blob.size }));
      return JSON.stringify({ entries: entries.slice(args.offset, args.offset + args.limit), total: entries.length,
        nextOffset: args.offset + args.limit < entries.length ? args.offset + args.limit : undefined });
    },
  };
}
