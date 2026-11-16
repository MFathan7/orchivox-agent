import { Writable } from "node:stream";
import type { SyncedOutputHandle, WriteTarget } from "./app";
import { FrameClock } from "./frame-clock";
import { RESET_ATTRIBUTES } from "./terminal-protocol";
import { displayWidth, graphemeClusters } from "./text-wrap";

interface TerminalTarget extends WriteTarget {
  columns?: number;
  rows?: number;
  isTTY?: boolean;
  on?: (event: string, listener: () => void) => unknown;
  removeListener?: (event: string, listener: () => void) => unknown;
}
interface Snapshot { text: string; width: number; height: number }

function fitAnsiRow(row: string, width: number): string {
  if (displayWidth(Bun.stripANSI(row)) <= width) return row;
  const tokens = row.split(/(\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/g);
  let result = "", used = 0, hasHyperlink = false;
  for (const token of tokens) {
    if (token.startsWith("\x1b")) {
      hasHyperlink ||= token.startsWith("\x1b]8;");
      result += token;
      continue;
    }
    for (const glyph of graphemeClusters(token)) {
      const size = displayWidth(glyph);
      if (used + size > width) return result + (hasHyperlink ? "\x1b]8;;\x1b\\" : "") + RESET_ATTRIBUTES;
      result += glyph; used += size;
    }
  }
  return result;
}

export class TerminalRenderer {
  readonly clock: FrameClock;
  readonly stdout: NodeJS.WriteStream;
  private pending?: Snapshot;
  private previous: string[] = [];
  private width = 0;
  private height = 0;
  private closed = false;
  private readonly target: TerminalTarget;
  private readonly resize: () => void;

  constructor(private readonly options: {
    output: SyncedOutputHandle;
    target?: TerminalTarget;
    onFrame?: (snapshot: string) => void;
  }) {
    this.target = options.target ?? process.stdout;
    this.clock = new FrameClock({ blocked: options.output.isBackpressured, paint: () => this.paint() });
    const stream = new Writable({
      write: (chunk, _encoding, done) => {
        if (this.closed) { done(); return; }
        const text = Buffer.from(chunk).toString("utf8");
        // Cursor visibility and clipboard requests are controls, not render snapshots.
        if (text === "\x1b[?25l" || text === "\x1b[?25h" || /^\x1b\]52;[^\x07\x1b]*(?:\x07|\x1b\\)$/.test(text)) this.target.write(text);
        else this.writeFrame(text);
        done();
      },
    });
    Object.defineProperties(stream, {
      columns: { get: () => this.target.columns ?? 80 },
      rows: { get: () => this.target.rows ?? 24 },
      isTTY: { get: () => Boolean(this.target.isTTY) },
    });
    this.stdout = stream as NodeJS.WriteStream;
    this.resize = () => {
      this.previous = [];
      this.stdout.emit("resize");
    };
    this.target.on?.("resize", this.resize);
  }

  writeFrame(text: string): void {
    if (this.closed) return;
    this.pending = { text, width: Math.max(1, this.target.columns ?? 80), height: Math.max(1, this.target.rows ?? 24) };
    this.clock.invalidate();
  }

  private paint(force = false): boolean {
    const frame = this.pending;
    if (!frame) return false;
    if (!force && this.options.output.isBackpressured()) return true;
    this.pending = undefined;
    const lines = frame.text.split("\n");
    const resized = this.width !== frame.width || this.height !== frame.height;
    let patch = "";
    const next: string[] = [];
    for (let row = 0; row < frame.height; row++) {
      const text = fitAnsiRow((lines[row] ?? "").replace(/\r$/, ""), frame.width);
      next.push(text);
      if (!resized && text === this.previous[row]) continue;
      // Absolute row anchors and disabled autowrap avoid bottom-row scrolling and wide-glyph drift.
      patch += `\x1b[${row + 1};1H${RESET_ATTRIBUTES}\x1b[2K${text}${RESET_ATTRIBUTES}`;
    }
    this.previous = next;
    this.width = frame.width;
    this.height = frame.height;
    if (patch) {
      this.target.write(`\x1b[?7l${patch}\x1b[${frame.height};1H\x1b[?7h`);
      this.options.output.flush();
      // Sharing clients receive a full snapshot; they do not emulate terminal deltas.
      this.options.onFrame?.(frame.text);
    }
    return false;
  }

  dispose(): void {
    if (this.closed) return;
    this.clock.dispose();
    this.paint(true);
    this.closed = true;
    this.target.removeListener?.("resize", this.resize);
  }
}
