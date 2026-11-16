import { killProcessTree } from "../tools/process-tree";
import type { RemoteConfig } from "../config/loader";
export const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
export const u64 = (value: number) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return bytes; };
export const str = (value: string | Uint8Array) => { const bytes = Buffer.from(value); return Buffer.concat([u32(bytes.length), bytes]); };
export class SftpReader {
  private offset = 0;
  constructor(readonly bytes: Buffer) {}
  private take(length: number) { if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) throw new Error("Malformed SFTP packet."); const value = this.bytes.subarray(this.offset, this.offset + length); this.offset += length; return value; }
  byte() { return this.take(1)[0]; }
  uint() { return this.take(4).readUInt32BE(); }
  size() { const value = Number(this.take(8).readBigUInt64BE()); if (!Number.isSafeInteger(value)) throw new Error("Remote file size exceeds safe range."); return value; }
  buffer() { return this.take(this.uint()); }
  text() { return new TextDecoder("utf-8", { fatal: true }).decode(this.buffer()); }
  get remaining() { return this.bytes.length - this.offset; }
  attrs() {
    const flags = this.uint(); const value: { size?: number; uid?: number; gid?: number; permissions?: number; atime?: number; mtime?: number } = {};
    if (flags & 1) value.size = this.size(); if (flags & 2) { value.uid = this.uint(); value.gid = this.uint(); }
    if (flags & 4) value.permissions = this.uint(); if (flags & 8) { value.atime = this.uint(); value.mtime = this.uint(); }
    if (flags & 0x80000000) { const count = this.uint(); if (count > 100) throw new Error("SFTP attributes exceeded the count limit."); for (let i = 0; i < count; i++) { this.buffer(); this.buffer(); } }
    return value;
  }
}
export class SftpFailure extends Error { constructor(readonly code: string, message: string, readonly status?: number) { super(message); } }
const statusMessages: Record<number, string> = { 1: "Remote end of file.", 2: "Remote path does not exist.", 3: "Remote permission denied.", 4: "Remote SFTP operation failed.", 5: "Remote server returned a malformed request status.", 6: "Remote connection is unavailable.", 7: "Remote connection lost.", 8: "Remote SFTP operation is unsupported." };
export class SftpClient {
  private readonly child: ReturnType<typeof Bun.spawn>;
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private failure?: SftpFailure;
  private closing?: Promise<void>;
  private stderr = "";
  private readonly stderrDone: Promise<void>;
  private readonly pending = new Map<number, { resolve: (reader: SftpReader) => void; reject: (error: Error) => void }>();
  readonly extensions = new Map<string, string>();
  private version?: { resolve: () => void; reject: (error: Error) => void };
  constructor(program: string, host: RemoteConfig["hosts"][string], private readonly timeoutMs: number) {
    const args = [program, "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`];
    if (host.ssh_config) args.push("-F", host.ssh_config); if (host.port) args.push("-p", String(host.port)); args.push("-s", "--", host.destination, "sftp");
    this.child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32" });
    this.stderrDone = this.stderrLoop(); void this.readLoop(); void this.child.exited.then(async () => { await this.stderrDone; this.fail(this.transportFailure()); });
  }
  get connected() { return !this.failure && !this.closing; }
  private transportFailure() {
    const message = this.stderr.toLowerCase();
    if (message.includes("host key verification failed") || message.includes("remote host identification has changed")) return new SftpFailure("ssh_host_key", "SSH host-key verification failed. Verify the host outside Orchivox; no keys were accepted automatically.");
    if (message.includes("permission denied") || message.includes("authentication failed")) return new SftpFailure("ssh_auth", "SSH authentication failed. Configure your OpenSSH keys/agent outside chat.");
    return new SftpFailure("sftp_disconnected", "SSH/SFTP connection closed. No write was replayed.");
  }
  private fail(error: SftpFailure) { if (this.failure) return; this.failure = error; this.version?.reject(error); this.version = undefined; for (const pending of [...this.pending.values()]) pending.reject(error); }
  private send(body: Buffer) { const input = this.child.stdin as Bun.FileSink; input.write(Buffer.concat([u32(body.length), body])); const flushed = input.flush(); if (flushed instanceof Promise) void flushed.catch(() => this.fail(this.transportFailure())); }
  async initialize(signal?: AbortSignal) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); this.version = undefined; };
      const cancel = () => { cleanup(); reject(signal?.reason ?? new Error("SFTP initialization cancelled.")); };
      const timer = setTimeout(() => { cleanup(); reject(new SftpFailure("sftp_timeout", "SFTP initialization timed out.")); }, this.timeoutMs);
      this.version = { resolve: () => { cleanup(); resolve(); }, reject: (error) => { cleanup(); reject(error); } }; signal?.addEventListener("abort", cancel, { once: true });
      try { this.send(Buffer.concat([Buffer.from([1]), u32(3)])); } catch (error) { cleanup(); reject(error); } if (signal?.aborted) cancel();
    });
  }
  request(type: number, fields: Buffer[], signal?: AbortSignal): Promise<SftpReader> {
    signal?.throwIfAborted(); if (!this.connected) return Promise.reject(this.failure ?? new SftpFailure("sftp_disconnected", "SFTP client is closed."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); this.pending.delete(id); };
      const cancel = () => { cleanup(); reject(signal?.reason ?? new Error("SFTP request cancelled.")); };
      const timer = setTimeout(() => { cleanup(); const error = new SftpFailure("sftp_timeout", "SFTP request timed out. It was not replayed."); this.fail(error); reject(error); }, this.timeoutMs);
      this.pending.set(id, { resolve: (reader) => { cleanup(); resolve(reader); }, reject: (error) => { cleanup(); reject(error); } }); signal?.addEventListener("abort", cancel, { once: true });
      try { this.send(Buffer.concat([Buffer.from([type]), u32(id), ...fields])); } catch (error) { cleanup(); reject(error); } if (signal?.aborted) cancel();
    });
  }
  private async readLoop() {
    try {
      for await (const chunk of this.child.stdout as ReadableStream<Uint8Array>) {
        if (this.buffer.length + chunk.length > 2 * 1024 * 1024) throw new Error("SFTP buffer exceeded 2 MiB."); this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32BE(); if (length < 1 || length > 1024 * 1024) throw new Error("SFTP packet exceeded the size limit."); if (this.buffer.length < length + 4) break;
          const reader = new SftpReader(this.buffer.subarray(4, length + 4)); this.buffer = this.buffer.subarray(length + 4); const type = reader.byte();
          if (type === 2) {
            if (!this.version) continue; if (reader.uint() !== 3) throw new Error("Only SFTP v3 is supported.");
            let count = 0; while (reader.remaining) { if (++count > 100) throw new Error("SFTP extension list exceeded the count limit."); this.extensions.set(reader.text(), reader.text()); } this.version.resolve(); continue;
          }
          const id = reader.uint(), pending = this.pending.get(id); if (!pending) continue;
          if (type === 101) { const status = reader.uint(); if (status) pending.reject(new SftpFailure(status === 3 ? "remote_permission_denied" : status === 2 ? "remote_not_found" : "sftp_status", statusMessages[status] ?? "Remote SFTP operation failed.", status)); else pending.resolve(new SftpReader(Buffer.from([type]))); }
          else pending.resolve(new SftpReader(Buffer.concat([Buffer.from([type]), reader.bytes.subarray(5)])));
        }
      }
      await this.stderrDone; this.fail(this.transportFailure());
    } catch { this.fail(new SftpFailure("sftp_protocol", "SFTP transport returned malformed or oversized protocol data.")); }
  }
  private async stderrLoop() { try { for await (const chunk of this.child.stderr as ReadableStream<Uint8Array>) this.stderr = (this.stderr + new TextDecoder().decode(chunk)).slice(-8000); } catch {} }
  async realpath(path: string, signal?: AbortSignal) { const reader = await this.request(16, [str(path)], signal); if (reader.byte() !== 104 || reader.uint() !== 1) throw new Error("Invalid SFTP canonical path response."); return reader.text(); }
  async stat(path: string, signal?: AbortSignal) { const reader = await this.request(17, [str(path)], signal); if (reader.byte() !== 105) throw new Error("Invalid SFTP stat response."); return reader.attrs(); }
  async open(path: string, flags: number, signal?: AbortSignal, mode?: number) { const reader = await this.request(3, [str(path), u32(flags), mode === undefined ? u32(0) : Buffer.concat([u32(4), u32(mode)])], signal); if (reader.byte() !== 102) throw new Error("Invalid SFTP open response."); return reader.buffer(); }
  async closeHandle(handle: Buffer, signal?: AbortSignal) { await this.request(4, [str(handle)], signal); }
  async read(handle: Buffer, offset: number, length: number, signal?: AbortSignal) { const reader = await this.request(5, [str(handle), u64(offset), u32(Math.min(length, 32768))], signal); if (reader.byte() !== 103) throw new Error("Invalid SFTP read response."); const data = reader.buffer(); if (data.length > Math.min(length, 32768)) throw new SftpFailure("sftp_protocol", "SFTP returned more bytes than requested."); return data; }
  async write(handle: Buffer, offset: number, data: Buffer, signal?: AbortSignal) { await this.request(6, [str(handle), u64(offset), str(data)], signal); }
  async setAttributes(path: string, mode: number, uid: number | undefined, gid: number | undefined, signal?: AbortSignal) { const owners = uid !== undefined && gid !== undefined; await this.request(9, [str(path), u32(4 | (owners ? 2 : 0)), ...(owners ? [u32(uid!), u32(gid!)] : []), u32(mode)], signal); }
  async remove(path: string, signal?: AbortSignal) { await this.request(13, [str(path)], signal); }
  async rename(from: string, to: string, signal?: AbortSignal) { await this.request(200, [str("posix-rename@openssh.com"), str(from), str(to)], signal); }
  async openDir(path: string, signal?: AbortSignal) { const reader = await this.request(11, [str(path)], signal); if (reader.byte() !== 102) throw new Error("Invalid SFTP opendir response."); return reader.buffer(); }
  async readDir(handle: Buffer, signal?: AbortSignal) { const reader = await this.request(12, [str(handle)], signal); if (reader.byte() !== 104) throw new Error("Invalid SFTP readdir response."); const count = reader.uint(); if (count > 5000) throw new Error("SFTP directory batch exceeded 5000 entries."); const entries = []; for (let i = 0; i < count; i++) { const name = reader.text(); reader.text(); entries.push({ name, ...reader.attrs() }); } return entries; }
  async close() { return this.closing ??= (async () => { this.fail(new SftpFailure("sftp_disconnected", "SFTP session closed.")); try { (this.child.stdin as Bun.FileSink).end(); } catch {} killProcessTree(this.child, { force: true }); await this.child.exited.catch(() => {}); })(); }
}
