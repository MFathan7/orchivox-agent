import { existsSync } from "node:fs";
import { posix } from "node:path";
import { z } from "zod";
import { RemoteConfigSchema, type RemoteConfig } from "../config/loader";
import { RemoteWorkspace, remoteUri } from "../remote/workspace";
import { SftpFailure } from "../remote/sftp";
import { redactSecrets } from "../security/secrets";
import type { ToolOutput } from "../types/tool-output";
import type { ToolExecutionContext, ToolRegistry } from "./registry";
import { ToolSessionSlots, toolDeadline } from "./session-runtime";

export class RemoteTools {
  private readonly config: RemoteConfig;
  private readonly slots: ToolSessionSlots<RemoteWorkspace>;
  constructor(config?: RemoteConfig) { this.config = config ?? RemoteConfigSchema.parse({}); this.slots = new ToolSessionSlots(this.config.max_sessions, this.config.idle_seconds * 1000); }
  stopForWorker(worker: string) { return this.slots.stopForWorker(worker); }
  dispose() { return this.slots.dispose(); }
  private program() { const value = this.config.ssh ?? "ssh"; return Bun.which(value) ?? (existsSync(value) ? value : undefined); }
  private async connection(host: string, signal: AbortSignal) {
    const current = this.slots.peek();
    if (current && current.alias !== host) throw new Error("Close the current remote connection before selecting another host.");
    if (current) return current;
    const config = this.config.hosts[host], program = this.program();
    if (!config) throw new Error("Choose a configured remote.hosts alias; arbitrary destinations are unavailable.");
    if (!program) throw new SftpFailure("ssh_missing", "OpenSSH executable unavailable. Install/configure it separately.");
    return this.slots.create(async (active) => { const workspace = new RemoteWorkspace(host, config, this.config, program); await workspace.open(active); return workspace; }, signal);
  }
  private async read(host: string, context: ToolExecutionContext | undefined, operation: (remote: RemoteWorkspace, signal: AbortSignal) => Promise<ToolOutput>): Promise<ToolOutput> {
    const signal = toolDeadline(context?.signal, this.config.timeout_ms); let used: RemoteWorkspace | undefined;
    for (let attempt = 0; ; attempt++) {
      try { used = await this.connection(host, signal); const result = await this.slots.use(signal, operation); return attempt ? { ...result, reason: result.reason ?? `Read recovered after ${attempt} reconnect attempt(s); no write was retried.` } : result; }
      catch (error) {
        if (used && !used.connected) await this.slots.closeIfCurrent(used);
        const transient = error instanceof SftpFailure && ["sftp_disconnected", "sftp_timeout"].includes(error.code);
        if (!signal.aborted && transient && attempt < this.config.reconnect_attempts) continue;
        return { status: context?.signal?.aborted ? "cancelled" : error instanceof SftpFailure && error.code === "ssh_missing" ? "unavailable" : "error", code: context?.signal?.aborted ? "remote_cancelled" : signal.aborted ? "remote_timeout" : error instanceof SftpFailure ? error.code : "remote_failed", text: redactSecrets(error instanceof Error ? error.message : String(error)), reason: "Read operations alone may reconnect within the configured limit; no remote write is replayed." };
      }
    }
  }
  registerTools(registry: ToolRegistry) {
    const aliases = Object.keys(this.config.hosts), Host = aliases.length ? z.enum(aliases as [string, ...string[]]) : z.string().min(1);
    const Path = z.string().max(4096).refine((value) => !value.includes("\0"), "NUL is not allowed.");
    const Read = z.object({ action: z.enum(["status", "list", "read", "hash", "search", "close"]).default("status"), host: Host.optional(), remotePath: Path.default("."), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50), maxBytes: z.number().int().min(16).max(50000).default(24000), query: z.string().min(1).max(1000).optional(), caseSensitive: z.boolean().default(true), maxDepth: z.number().int().min(0).max(10).default(5) }).refine((args) => args.action === "status" || args.action === "close" || !!args.host, { message: "An explicit configured host is required for every remote file operation.", path: ["host"] });
    registry.register({ name: "remote_read", description: "Read a configured SSH project through OpenSSH/SFTP without remote shell execution. status does not connect; list/read/hash/search connect only to an owner-configured alias/root. remotePath is root-relative, never a local filePath. read continuation offsets are UTF-8-safe byte offsets; hash reads bounded complete files. Search is literal, bounded and skips symlinks/binary/invalid UTF-8; local ignores/LSP/AST do not apply to remote data. One active host per chat/agent/workspace; close before changing hosts. SSH agent/known_hosts stay outside chat; host-key verification is required.", parameters: Read, readOnly: true,
      execute: async (input, context): Promise<ToolOutput> => {
        const args = Read.parse(input);
        if (args.action === "status") return { status: "success", text: JSON.stringify({ connected: this.slots.peek()?.connected ?? false, host: this.slots.peek()?.alias, root: this.slots.peek()?.root, writeAvailable: this.slots.peek()?.writable ?? false, sshAvailable: !!this.program(), hosts: aliases.map((name) => ({ name, root: this.config.hosts[name]!.root, writeConfigured: this.config.hosts[name]!.allow_write })) }) };
        if (args.action === "close") { await this.slots.closeCurrent(); return { status: "success", text: "Owned SSH/SFTP connection closed." }; }
        const host = args.host; if (!host || !this.config.hosts[host]) return { status: "unavailable", code: "remote_host_unconfigured", text: "Choose a host from remote_read status after configuring remote.hosts." };
        return this.read(host, context, async (remote, signal) => {
          if (args.action === "list") {
            const result = await remote.list(args.remotePath, args.offset, args.limit, signal);
            return { status: result.partial ? "partial" : result.entries.length ? "success" : "empty", text: JSON.stringify({ host, ...result, note: "Live SFTP directory order can change between pages." }), sources: [{ uri: result.uri }], coverage: { scope: result.uri, returned: result.entries.length, complete: !result.partial, unit: "entries" }, continuation: result.nextOffset === undefined ? { message: "No further page within the scan bound; narrow the directory if partial." } : { tool: "remote_read", arguments: { ...args, offset: result.nextOffset }, message: "Read the next directory page." } };
          }
          if (args.action === "hash") { const result = await remote.hash(args.remotePath, signal); return { status: "success", text: JSON.stringify({ host, uri: result.uri, hash: result.hash, size: result.bytes.length, version: result.stat }), sources: [{ uri: result.uri }], coverage: { scope: result.uri, returned: result.bytes.length, total: result.bytes.length, complete: true, unit: "bytes" } }; }
          if (args.action === "read") {
            const result = await remote.read(args.remotePath, args.offset, args.maxBytes, signal), { text, ...metadata } = result;
            return { status: result.changed || result.nextOffset !== undefined ? "partial" : result.bytesRead ? "success" : "empty", text: JSON.stringify({ host, ...metadata, text }), sources: [{ uri: result.uri }], coverage: { scope: result.uri, complete: !result.changed && args.offset === 0 && result.nextOffset === undefined, returned: result.bytesRead, total: result.size, unit: "bytes" }, ...(result.changed ? { reason: "File metadata changed during read; obtain a fresh hash before editing." } : {}), continuation: result.nextOffset === undefined ? undefined : { tool: "remote_read", arguments: { ...args, offset: result.nextOffset }, message: "Continue using this UTF-8-safe byte offset." } };
          }
          if (!args.query) throw new Error("Literal search requires query.");
          const queue = [{ path: args.remotePath, depth: 0 }], matches: Array<{ uri: string; line: number; text: string }> = [];
          let files = 0, entries = 0, skipped = 0, denied = 0;
          const needle = args.caseSensitive ? args.query : args.query.toLowerCase();
          while (queue.length && files < this.config.max_search_files && entries < this.config.max_scan_entries && matches.length < args.limit) {
            signal.throwIfAborted(); const directory = queue.shift()!; let offset = 0;
            for (;;) {
              const page = await remote.list(directory.path, offset, Math.min(100, this.config.max_scan_entries - entries), signal);
              for (const entry of page.entries) {
                if (++entries > this.config.max_scan_entries) break;
                const kind = (entry.permissions ?? 0) & 0o170000;
                if (kind === 0o040000) { if (directory.depth < args.maxDepth) queue.push({ path: entry.remotePath, depth: directory.depth + 1 }); else skipped++; continue; }
                if (kind !== 0o100000) { skipped++; continue; }
                if (files >= this.config.max_search_files) break;
                const decision = await registry.authorize("remote_read", { host, remotePath: entry.remotePath, action: "read" }, signal); if (!decision.allowed) { denied++; continue; }
                files++;
                try {
                  const file = await remote.read(entry.remotePath, 0, args.maxBytes, signal);
                  file.text.split("\n").forEach((line, index) => { if (matches.length < args.limit && (args.caseSensitive ? line : line.toLowerCase()).includes(needle)) matches.push({ uri: file.uri, line: index + 1, text: line.slice(0, 500) }); });
                  if (file.nextOffset !== undefined || file.changed) skipped++;
                } catch (error) { signal.throwIfAborted(); if (error instanceof SftpFailure && ["sftp_disconnected", "sftp_timeout"].includes(error.code)) throw error; skipped++; }
                if (matches.length >= args.limit) break;
              }
              if (page.nextOffset === undefined || entries >= this.config.max_scan_entries || files >= this.config.max_search_files || matches.length >= args.limit) break;
              offset = page.nextOffset;
            }
          }
          const scope = remoteUri(host, posix.join(remote.root, args.remotePath));
          return { status: "partial", text: JSON.stringify({ host, matches, scannedFiles: files, scannedEntries: entries, skipped, deniedFiles: denied, note: "Literal search inspects bounded UTF-8 prefixes; symlinks are not traversed and local gitignore/LSP/AST are not applied. No matches does not establish remote-wide absence." }), sources: [{ uri: scope }], coverage: { scope, complete: false, returned: matches.length, unit: "matches" }, continuation: { tool: "remote_read", message: "Narrow remotePath/maxDepth or read a returned remote URI through its configured host and root-relative path." } };
        });
      } });
    const Edit = z.object({ host: Host, remotePath: Path.min(1), expectedUri: z.string().min(1).max(12000).describe("Exact ssh:// URI returned by the inspected file; prevents root/symlink retargeting."), expectedHash: z.string().regex(/^[a-f0-9]{64}$/), newText: z.string().max(this.config.max_file_bytes).refine((value) => !value.includes("\0"), "Remote text replacements cannot contain NUL.") });
    registry.register({ name: "remote_edit", description: "Replace one existing UTF-8 remote file using the exact source URI and a fresh hash from remote_read. Requires host.allow_write and OpenSSH posix-rename support. Stages an exclusive temporary file, rechecks the original hash/path, and atomically renames. Hash checks are optimistic, not server compare-and-swap locking. No create/delete/arbitrary shell; no automatic write retry. Remote changes are outside local Git/undo counts and follow separate write permissions; unavailable in PLAN.", parameters: Edit, readOnly: false, enabled: () => aliases.some((alias) => this.config.hosts[alias]!.allow_write),
      execute: async (input, context): Promise<ToolOutput> => {
        const args = Edit.parse(input), signal = toolDeadline(context?.signal, this.config.timeout_ms); let used: RemoteWorkspace | undefined;
        if (!this.config.hosts[args.host]?.allow_write) return { status: "unavailable", code: "remote_write_disabled", text: "Owner must enable remote.hosts.<alias>.allow_write before remote edits." };
        try {
          used = await this.connection(args.host, signal);
          if (!used.writable) return { status: "unavailable", code: "remote_write_unsupported", text: "The remote server does not advertise the required posix-rename extension." };
          return await this.slots.use(signal, async (remote, active) => { const result = await remote.edit(args.remotePath, args.expectedHash, args.expectedUri, args.newText, active); return { status: "success", text: JSON.stringify(result), sources: [{ uri: result.uri }] }; });
        } catch (error) {
          if (used && !used.connected) await this.slots.closeIfCurrent(used);
          return { status: context?.signal?.aborted ? "cancelled" : "error", code: error instanceof SftpFailure ? error.code : signal.aborted ? "remote_write_uncertain" : "remote_edit_failed", text: redactSecrets(error instanceof Error ? error.message : String(error)), reason: "No write is replayed automatically. Inspect remote contents before retrying an interrupted edit." };
        }
      } });
  }
}
