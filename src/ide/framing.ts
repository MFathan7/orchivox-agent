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
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): unknown[] {
    this.buffer = concatBytes(this.buffer, chunk);
    const messages: unknown[] = [];
    while (true) {
      const headerEnd = indexOfSequence(this.buffer, "\r\n\r\n");
      if (headerEnd === -1) break;
      const header = new TextDecoder().decode(this.buffer.subarray(0, headerEnd));
      const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) throw new Error(`malformed frame header: ${header}`);
      const length = Number(lengthMatch[1]);
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
  private readonly decoder = new FrameDecoder();
  private handler: MessageHandler | undefined;
  private stderrText = "";

  constructor(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
    this.proc = Bun.spawn([command, ...args], {
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
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  send(message: unknown): void {
    this.stdin.write(encodeFrame(message));
    this.stdin.flush();
  }

  getStderr(): string {
    return this.stderrText;
  }

  async close(): Promise<void> {
    try {
      this.stdin.end();
    } catch {
      // the process may already be gone
    }
    this.proc.kill();
  }

  private async readLoop(): Promise<void> {
    const reader = this.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const message of this.decoder.push(value)) this.handler?.(message);
      }
    } catch {
      // transport closed while reading
    }
  }

  private async drainStderr(): Promise<void> {
    const reader = this.stderr.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderrText += new TextDecoder().decode(value);
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
