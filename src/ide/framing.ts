import { killProcessTree } from "../tools/process-tree";

export type MessageHandler = (message: unknown) => void;

export function encodeFrame(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const header = new TextEncoder().encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
  const frame = new Uint8Array(header.byteLength + body.byteLength);
  frame.set(header, 0);
  frame.set(body, header.byteLength);
  return frame;
}

export class FrameDecoder {
  constructor(private readonly maxBytes = Infinity) {}
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): unknown[] {
    if (this.buffer.byteLength + chunk.byteLength > this.maxBytes + 16384) throw new Error("Framed message exceeded the configured size limit.");
    this.buffer = concatBytes(this.buffer, chunk);
    const messages: unknown[] = [];
    while (true) {
      const headerEnd = indexOfSequence(this.buffer, "\r\n\r\n");
      if (headerEnd === -1) { if (Number.isFinite(this.maxBytes) && this.buffer.length > Math.min(this.maxBytes, 16384)) throw new Error("Framed message header exceeded the size limit."); break; }
      const header = new TextDecoder().decode(this.buffer.subarray(0, headerEnd));
      const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) throw new Error(`malformed frame header: ${header}`);
      const length = Number(lengthMatch[1]);
      if (!Number.isSafeInteger(length) || length > this.maxBytes) throw new Error("Framed message body exceeded the configured size limit.");
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) break;
      const body = this.buffer.subarray(bodyStart, bodyStart + length);
      messages.push(JSON.parse(new TextDecoder().decode(body)));
      this.buffer = this.buffer.subarray(bodyStart + length);
    }
    return messages;
  }
}

export class StdioFramedTransport {
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly stdin: Bun.FileSink;
  private readonly stdout: ReadableStream<Uint8Array>;
  private readonly stderr: ReadableStream<Uint8Array>;
  private readonly decoder: FrameDecoder;
  private readonly killTree: boolean;
  private readonly label: string;
  private readonly maxStderrBytes: number;
  private handler: MessageHandler | undefined;
  private stderrText = "";
  private closedError?: Error;
  private closeHandler?: (error: Error) => void;

  constructor(command: string, args: string[], options: { cwd?: string; env?: Record<string, string>; killTree?: boolean; maxMessageBytes?: number; label?: string; maxStderrBytes?: number } = {}) {
    this.decoder = new FrameDecoder(options.maxMessageBytes); this.killTree = options.killTree === true; this.label = options.label ?? "Language server"; this.maxStderrBytes = options.maxStderrBytes ?? Infinity;
    this.proc = Bun.spawn([command, ...args], {
      detached: this.killTree && process.platform !== "win32",
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: options.cwd,
      env: { ...collectEnv(), ...options.env },
    });
    this.stdin = this.proc.stdin as Bun.FileSink;
    this.stdout = this.proc.stdout as ReadableStream<Uint8Array>;
    this.stderr = this.proc.stderr as ReadableStream<Uint8Array>;
    void this.readLoop();
    void this.drainStderr();
    void this.proc.exited.then((code) => this.ended(new Error(`${this.label} process exited (${code}).`)));
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  onClose(handler: (error: Error) => void): void {
    this.closeHandler = handler;
    if (this.closedError) handler(this.closedError);
  }

  isOpen(): boolean { return !this.closedError; }

  private ended(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    this.closeHandler?.(error);
  }

  send(message: unknown): void {
    if (this.closedError) throw this.closedError;
    this.stdin.write(encodeFrame(message));
    const flushed = this.stdin.flush();
    if (flushed instanceof Promise) void flushed.catch((error) => this.ended(error instanceof Error ? error : new Error(String(error))));
  }

  getStderr(): string {
    return this.stderrText;
  }

  async close(): Promise<void> {
    this.ended(new Error(`${this.label} transport closed.`));
    try {
      this.stdin.end();
    } catch {
      // the process may already be gone
    }
    if (this.killTree) { killProcessTree(this.proc, { force: true }); await this.proc.exited.catch(() => {}); return; }
    try { this.proc.kill(); } catch { /* The process may already have exited. */ }
  }

  private async readLoop(): Promise<void> {
    const reader = this.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const message of this.decoder.push(value)) this.handler?.(message);
      }
      this.ended(new Error(`${this.label} output stream closed.`));
    } catch (error) {
      this.ended(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async drainStderr(): Promise<void> {
    const reader = this.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderrText = (this.stderrText + new TextDecoder().decode(value)).slice(-this.maxStderrBytes);
      }
    } catch {
      // transport closed while reading
    }
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

function indexOfSequence(buffer: Uint8Array, needle: string): number {
  const target = new TextEncoder().encode(needle);
  for (let i = 0; i <= buffer.byteLength - target.byteLength; i += 1) {
    let matched = true;
    for (let j = 0; j < target.byteLength; j += 1) {
      if (buffer[i + j] !== target[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

function collectEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(globalThis.process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
