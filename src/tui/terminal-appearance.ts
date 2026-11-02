import type { TerminalAppearance } from "../types/theme";

const OSC_11_QUERY = "\x1b]11;?\x1b\\";
const OSC_11_RESPONSE =
  /\x1b\]11;(rgba?):([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})(?:\/([0-9a-f]{2,4}))?(?:\x07|\x1b\\)/i;
const DEFAULT_TIMEOUT_MS = 250;
const LIGHT_LUMINANCE = 0.5;

/** An explicit appearance override for terminals that do not answer OSC 11. */
export function normalizeAppearanceOverride(value: string | undefined): TerminalAppearance {
  const normalized = value?.trim().toLowerCase();
  return normalized === "light" || normalized === "dark" ? normalized : "unknown";
}

/**
 * Reads a terminal background report. Both xterm's 4-digit channels and the
 * shorter 2-digit form are accepted, as are BEL and ST terminators.
 */
export function appearanceFromOsc11(data: string): TerminalAppearance {
  const match = OSC_11_RESPONSE.exec(data);
  if (!match) return "unknown";
  const channels = [match[2], match[3], match[4]].map((hex) => {
    const scale = 16 ** hex.length - 1;
    return Number.parseInt(hex, 16) / scale;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance >= LIGHT_LUMINANCE ? "light" : "dark";
}

interface AppearanceStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
  resume?: () => void;
  pause?: () => void;
  on: (event: "data", listener: (chunk: Buffer | string) => void) => void;
  removeListener: (event: "data", listener: (chunk: Buffer | string) => void) => void;
}

export interface DetectAppearanceOptions {
  stdin?: AppearanceStream;
  write?: (chunk: string) => void;
  timeoutMs?: number;
}

/**
 * Asks the terminal for its background color without blocking startup for long.
 * A terminal that does not answer resolves to unknown, which keeps the dark
 * default instead of guessing.
 */
export async function detectTerminalAppearance(
  options: DetectAppearanceOptions = {},
): Promise<TerminalAppearance> {
  const override = normalizeAppearanceOverride(process.env.ORCHIVOX_APPEARANCE);
  if (override !== "unknown") return override;
  const stdin = options.stdin ?? (process.stdin as unknown as AppearanceStream);
  if (stdin.isTTY !== true) return "unknown";
  if (!options.write && (process.stdout.isTTY !== true || process.env.TERM === "dumb")) {
    return "unknown";
  }
  const write =
    options.write ??
    ((chunk: string) => {
      process.stdout.write(chunk);
    });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wasRaw = stdin.isRaw === true;

  return new Promise<TerminalAppearance>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let buffer = "";

    const finish = (appearance: TerminalAppearance): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdin.removeListener("data", onData);
      if (!wasRaw) {
        try {
          stdin.setRawMode?.(false);
        } catch {
          // The terminal may already be gone.
        }
      }
      // Ink reads stdin in paused mode. Leaving the stream flowing would drop
      // input before Ink attaches its readable listener.
      stdin.pause?.();
      resolve(appearance);
    };

    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const appearance = appearanceFromOsc11(buffer);
      if (appearance !== "unknown") finish(appearance);
    };

    timer = setTimeout(() => finish("unknown"), timeoutMs);
    try {
      if (!wasRaw) stdin.setRawMode?.(true);
      stdin.resume?.();
      stdin.on("data", onData);
      write(OSC_11_QUERY);
    } catch {
      finish("unknown");
    }
  });
}
