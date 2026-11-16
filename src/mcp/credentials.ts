import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runToolProcess } from "../tools/process";

export interface CredentialStore {
  readonly label: string;
  readonly available: boolean;
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class SessionCredentialStore implements CredentialStore {
  readonly label = "Memory only (cleared on exit)";
  readonly available = true;
  private readonly values = new Map<string, string>();
  async read(key: string) { return this.values.get(key); }
  async write(key: string, value: string) { this.values.set(key, value); }
  async remove(key: string) { this.values.delete(key); }
}

type Runner = (argv: string[], options: { input?: string; timeoutMs?: number; maxBytes?: number; cwd?: string }) => Promise<{ code: number; output: string; error: string; truncated: boolean }>;
const service = "orchivox.mcp.oauth";
const utf8Console = '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ';
const dpapiEncrypt = utf8Console + '$ErrorActionPreference="Stop"; $credentialPayload=[Console]::In.ReadToEnd(); $credentialSecure=ConvertTo-SecureString -String $credentialPayload -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString -SecureString $credentialSecure))';
const dpapiDecrypt = utf8Console + '$ErrorActionPreference="Stop"; $credentialEncrypted=[Console]::In.ReadToEnd(); $credentialSecure=ConvertTo-SecureString -String $credentialEncrypted; [Console]::Out.Write(([System.Net.NetworkCredential]::new("",$credentialSecure)).Password)';

export class NativeCredentialStore implements CredentialStore {
  readonly label: string;
  readonly available: boolean;
  private readonly executable: string | null;
  private readonly platform: string;
  private readonly directory: string;
  private readonly run: Runner;
  constructor(options: { platform?: string; directory?: string; which?: (name: string) => string | null; run?: Runner } = {}) {
    this.platform = options.platform ?? process.platform;
    const which = options.which ?? ((name: string) => Bun.which(name));
    this.executable = this.platform === "darwin" ? which("security") : this.platform === "linux" ? which("secret-tool")
      : this.platform === "win32" ? which("powershell.exe") ?? which("pwsh.exe") : null;
    this.label = this.platform === "darwin" ? "macOS Keychain" : this.platform === "linux" ? "Linux Secret Service (secret-tool)"
      : this.platform === "win32" ? "Windows DPAPI (current user)" : "OS credential store unavailable";
    this.available = this.executable !== null;
    this.directory = options.directory ?? join(homedir(), ".orchivox", "mcp-auth");
    this.run = options.run ?? runToolProcess;
  }
  private account(key: string) { return createHash("sha256").update(key).digest("hex"); }
  private path(key: string) { return join(this.directory, `${this.account(key)}.dpapi`); }
  private async command(args: string[], input?: string) {
    if (!this.executable) throw new Error("OS credential store is unavailable. Choose memory-only login.");
    try {
      const result = await this.run([this.executable, ...args], { input, timeoutMs: 10000, maxBytes: 256 * 1024, cwd: homedir() });
      if (result.truncated) throw new Error();
      return result;
    } catch { throw new Error("OS credential store could not be accessed. Unlock it or choose memory-only login."); }
  }
  private powershell(script: string, input: string) { return this.command(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], input); }
  async read(key: string): Promise<string | undefined> {
    let result;
    if (this.platform === "win32") {
      const file = Bun.file(this.path(key)); if (!await file.exists()) return undefined;
      result = await this.powershell(dpapiDecrypt, await file.text());
    } else if (this.platform === "darwin") {
      result = await this.command(["find-generic-password", "-s", service, "-a", this.account(key), "-w"]);
      if (result.code === 44) return undefined;
      if (result.code === 0) { try { return Buffer.from(result.output.trim(), "base64").toString("utf8"); } catch { throw new Error("Saved MCP credential could not be decoded."); } }
    } else {
      result = await this.command(["lookup", "service", service, "account", this.account(key)]);
      if (result.code === 1 && !result.output && !result.error) return undefined;
    }
    if (result.code !== 0) throw new Error("Saved MCP credential could not be read. Unlock the OS credential store.");
    return result.output.trim() || undefined;
  }
  async write(key: string, value: string): Promise<void> {
    if (Buffer.byteLength(value) > 64 * 1024) throw new Error("MCP credential exceeds the storage limit.");
    if (this.platform === "win32") {
      const result = await this.powershell(dpapiEncrypt, value);
      if (result.code !== 0 || !/^[0-9a-f]+$/i.test(result.output.trim()) || result.output.trim() === value) throw new Error("Windows DPAPI encryption failed. No plaintext credential was saved.");
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path(key)}.${crypto.randomUUID()}.tmp`;
      try { await writeFile(temporary, result.output.trim(), { mode: 0o600, flag: "wx" }); await rename(temporary, this.path(key)); }
      finally { await rm(temporary, { force: true }); }
      return;
    }
    const result = this.platform === "darwin"
      ? await this.command(["-i"], `add-generic-password -U -s ${service} -a ${this.account(key)} -w ${Buffer.from(value).toString("base64")}\nquit\n`)
      : await this.command(["store", "--label=Orchivox MCP OAuth", "service", service, "account", this.account(key)], value);
    if (result.code !== 0) throw new Error("OS credential store refused the credential. No plaintext fallback was used.");
    if (await this.read(key) !== value) throw new Error("OS credential store did not confirm saving the credential.");
  }
  async remove(key: string): Promise<void> {
    if (this.platform === "win32") { await rm(this.path(key), { force: true }); return; }
    const result = this.platform === "darwin" ? await this.command(["delete-generic-password", "-s", service, "-a", this.account(key)])
      : await this.command(["clear", "service", service, "account", this.account(key)]);
    if (result.code !== 0 && !(this.platform === "darwin" && result.code === 44) && !(this.platform === "linux" && result.code === 1 && !result.error)) throw new Error("OS credential deletion failed. Stored credentials may remain.");
  }
}
