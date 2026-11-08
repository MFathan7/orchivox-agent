export type TerminalWriter = (chunk: string) => unknown;

export const ENTER_ALTERNATE_SCREEN =
  "\x1b[?1049h\x1b[H\x1b[2J\x1b[?1000h\x1b[?1006h";
export const LEAVE_ALTERNATE_SCREEN = "\x1b[?1049l\x1b[?25h";
export const ENABLE_KEYBOARD_PROTOCOL = "\x1b[>1u\x1b[>4;2m";
export const DISABLE_KEYBOARD_PROTOCOL = "\x1b[>4;0m\x1b[<u";

const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";

let entered = false;

function defaultWrite(chunk: string): void {
  process.stdout.write(chunk);
}

/**
 * Enters the alternate screen once, then pushes the kitty keyboard flags.
 * The push must happen after the screen switch so terminals that keep
 * per-screen flag state apply it to the screen the TUI actually uses.
 */
export function enterTerminal(write: TerminalWriter = defaultWrite): void {
  if (entered) return;
  write(ENTER_ALTERNATE_SCREEN);
  write(ENABLE_KEYBOARD_PROTOCOL);
  entered = true;
}

/**
 * Pops exactly the keyboard flag pushed by enterTerminal, before leaving the
 * alternate screen. Calls after the first are no-ops so cleanup can run from
 * both the signal handler and the normal exit path.
 */
export function leaveTerminal(write: TerminalWriter = defaultWrite): void {
  if (!entered) return;
  entered = false;
  write(DISABLE_MOUSE);
  write(DISABLE_KEYBOARD_PROTOCOL);
  write(LEAVE_ALTERNATE_SCREEN);
}

export function resetTerminalProtocolForTests(): void {
  entered = false;
}

export type FatalSignal = "uncaughtException" | "unhandledRejection";

export interface FatalEventTarget {
  on(event: string, listener: (value: unknown) => void): unknown;
  removeListener(event: string, listener: (value: unknown) => void): unknown;
}

/**
 * Registers the fatal process handlers and returns an uninstall function.
 * The caller owns the terminal restore step inside `onFatal`.
 */
export function installFatalHandlers(
  onFatal: (error: unknown, signal: FatalSignal) => void,
  target: FatalEventTarget = globalThis.process as unknown as FatalEventTarget,
): () => void {
  const uncaught = (error: unknown): void => onFatal(error, "uncaughtException");
  const rejection = (reason: unknown): void => onFatal(reason, "unhandledRejection");
  target.on("uncaughtException", uncaught);
  target.on("unhandledRejection", rejection);
  return () => {
    target.removeListener("uncaughtException", uncaught);
    target.removeListener("unhandledRejection", rejection);
  };
}

/** Set the window or pane title without touching the screen buffer. */
export function setTerminalTitle(title: string, write: TerminalWriter = defaultWrite): void {
  const clean = title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  write(`\u001b]2;${clean.length > 0 ? clean : "Orchivox"}\u0007`);
}
