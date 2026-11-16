import { posix } from "node:path";
import type { RemoteConfig } from "../config/loader";
import { SftpClient, SftpFailure } from "./sftp";
export const remoteHash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export function remoteUri(alias: string, path: string) { return `ssh://${alias}${path.split("/").map(encodeURIComponent).join("/")}`; }
export class RemoteWorkspace {
  private client?: SftpClient;
  root = "";
  constructor(readonly alias: string, private readonly host: RemoteConfig["hosts"][string], private readonly config: RemoteConfig, private readonly program: string) {}
  get connected() { return this.client?.connected === true; }
  get writable() { return this.connected && this.host.allow_write && this.client?.extensions.get("posix-rename@openssh.com") === "1"; }
  async open(signal: AbortSignal) {
    try { this.client = new SftpClient(this.program, this.host, this.config.timeout_ms); await this.client.initialize(signal); this.root = await this.client.realpath(this.host.root, signal); const stat = await this.client.stat(this.root, signal); if (stat.permissions !== undefined && (stat.permissions & 0o170000) !== 0o040000) throw new Error("Configured remote root is not a directory."); }
    catch (error) { await this.close(); throw error; }
  }
  private inside(path: string) { return path === this.root || path.startsWith(this.root === "/" ? "/" : `${this.root}/`); }
  async path(relative: string, signal: AbortSignal) {
    if (relative.includes("\0") || posix.isAbsolute(relative)) throw new Error("Use a root-relative remotePath, not a local/absolute path.");
    const candidate = posix.resolve(this.root, relative); if (!this.inside(candidate)) throw new Error("Remote path is outside the configured root.");
    const canonical = await this.client!.realpath(candidate, signal); if (!this.inside(canonical)) throw new Error("Remote symlink resolves outside the configured root."); return canonical;
  }
  async list(relative: string, offset: number, limit: number, signal: AbortSignal) {
    const path = await this.path(relative, signal), handle = await this.client!.openDir(path, signal); let scanned = 0, more = false; const entries = [];
    try {
      while (scanned < this.config.max_scan_entries) {
        let batch;
        try { batch = await this.client!.readDir(handle, signal); } catch (error) { if (error instanceof SftpFailure && error.status === 1) break; throw error; }
        if (!batch.length) break;
        for (const entry of batch) {
          if ([".", ".."].includes(entry.name)) continue;
          if (scanned >= this.config.max_scan_entries) { more = true; break; }
          if (entry.name.includes("/") || entry.name.includes("\0")) throw new Error("Remote directory returned an invalid entry name.");
          if (scanned++ < offset) continue;
          if (entries.length < limit) entries.push({ ...entry, uri: remoteUri(this.alias, posix.join(path, entry.name)), remotePath: posix.relative(this.root, posix.join(path, entry.name)) });
          else { more = true; break; }
        }
        if (more || scanned >= this.config.max_scan_entries) { more = true; break; }
      }
      return { uri: remoteUri(this.alias, path), entries, scanned, partial: more, nextOffset: more && offset + entries.length < this.config.max_scan_entries ? offset + entries.length : undefined };
    } finally { if (this.connected) await this.client!.closeHandle(handle, AbortSignal.timeout(500)).catch(() => {}); }
  }
  private async bytes(path: string, offset: number, maximum: number, signal: AbortSignal) {
    const before = await this.client!.stat(path, signal), handle = await this.client!.open(path, 1, signal); const chunks: Buffer[] = []; let size = 0;
    try {
      while (size < maximum) {
        let chunk: Buffer;
        try { chunk = await this.client!.read(handle, offset + size, maximum - size, signal); } catch (error) { if (error instanceof SftpFailure && error.status === 1) break; throw error; }
        if (!chunk.length) break; chunks.push(chunk); size += chunk.length;
      }
      const after = await this.client!.stat(path, signal);
      return { bytes: Buffer.concat(chunks), stat: after, changed: before.size !== after.size || before.mtime !== after.mtime };
    } finally { if (this.connected) await this.client!.closeHandle(handle, AbortSignal.timeout(500)).catch(() => {}); }
  }
  async hash(relative: string, signal: AbortSignal) {
    const path = await this.path(relative, signal), stat = await this.client!.stat(path, signal);
    if (stat.size === undefined || stat.size > this.config.max_file_bytes) throw new Error(`Remote hash/edit is limited to ${this.config.max_file_bytes} bytes.`);
    const result = await this.bytes(path, 0, this.config.max_file_bytes + 1, signal);
    if (result.changed || result.bytes.length !== stat.size || result.bytes.length > this.config.max_file_bytes) throw new Error("Remote file changed while hashing; obtain a fresh version.");
    return { path, uri: remoteUri(this.alias, path), hash: remoteHash(result.bytes), bytes: result.bytes, stat: result.stat };
  }
  async read(relative: string, offset: number, maximum: number, signal: AbortSignal) {
    const path = await this.path(relative, signal), result = await this.bytes(path, offset, maximum, signal);
    if (result.bytes.includes(0)) throw new Error("Remote file appears binary. Text reads/edits support UTF-8 only.");
    const more = result.stat.size === undefined || offset + result.bytes.length < result.stat.size;
    let visible = result.bytes, text: string | undefined;
    for (let trim = 0; trim <= (more ? 3 : 0); trim++) { try { visible = result.bytes.subarray(0, result.bytes.length - trim); text = new TextDecoder("utf-8", { fatal: true }).decode(visible); break; } catch {} }
    if (text === undefined) throw new Error("Remote content is not valid UTF-8 at this offset; use the returned continuation offsets.");
    return { uri: remoteUri(this.alias, path), text, bytesRead: visible.length, size: result.stat.size, changed: result.changed, hash: !more && offset === 0 && !result.changed ? remoteHash(visible) : undefined, nextOffset: more && visible.length ? offset + visible.length : undefined };
  }
  async edit(relative: string, expectedHash: string, expectedUri: string, text: string, signal: AbortSignal) {
    if (!this.writable) throw new Error("Remote writes require host.allow_write and server posix-rename support.");
    const next = Buffer.from(text); if (next.length > this.config.max_file_bytes) throw new Error("Remote replacement exceeds max_file_bytes.");
    const original = await this.hash(relative, signal);
    if (original.uri !== expectedUri) throw new Error("Remote file identity changed since inspection; obtain its current URI and hash before editing.");
    if (original.hash !== expectedHash) throw new Error("Remote file changed since inspection; no edit applied.");
    new TextDecoder("utf-8", { fatal: true }).decode(original.bytes); if (original.bytes.includes(0)) throw new Error("Remote binary edits are unsupported.");
    const temp = posix.join(posix.dirname(original.path), `.orchivox-${crypto.randomUUID()}.tmp`); let staged = false, committed = false;
    try {
      const handle = await this.client!.open(temp, 2 | 8 | 32, signal, (original.stat.permissions ?? 0o600) & 0o777); staged = true;
      try { for (let offset = 0; offset < next.length; offset += 32768) await this.client!.write(handle, offset, next.subarray(offset, offset + 32768), signal); }
      finally { if (this.connected) await this.client!.closeHandle(handle, AbortSignal.timeout(500)).catch(() => {}); }
      await this.client!.setAttributes(temp, (original.stat.permissions ?? 0o600) & 0o7777, original.stat.uid, original.stat.gid, signal);
      const current = await this.hash(relative, signal); if (current.hash !== expectedHash || current.path !== original.path) throw new Error("Remote content/path changed during preparation; no replacement applied.");
      signal.throwIfAborted(); await this.client!.rename(temp, original.path, signal); committed = true;
      return { uri: original.uri, hash: remoteHash(next), changed: true, bytes: next.length, note: "Atomic rename acknowledged. Hash checks are optimistic, not a server-side compare-and-swap lock." };
    } catch (error) {
      if (!this.connected || signal.aborted) throw new SftpFailure("remote_write_uncertain", `Remote write was interrupted; effects may have occurred. It was not replayed. Inspect ${original.uri}. Staging path: ${remoteUri(this.alias, temp)}`);
      throw error;
    } finally { if (staged && !committed && this.connected) await this.client!.remove(temp, AbortSignal.timeout(500)).catch(() => {}); }
  }
  async close() { await this.client?.close(); }
}
