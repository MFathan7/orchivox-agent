import { isInputDebugEnabled, writeInputDebug } from "./input-debug";

export interface InputEmitter {
  emit(event: string | symbol, ...args: unknown[]): boolean;
}

const patchedEmitters = new WeakSet<object>();

function modifierBits(modifier: number): { shift: boolean; alt: boolean; ctrl: boolean } {
  const bits = Math.max(0, modifier - 1);
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
  };
}

function controlByte(code: number): string | undefined {
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  if (code >= 65 && code <= 90) return String.fromCharCode(code - 64);
  if (code === 91) return "\x1b";
  if (code === 92) return "\x1c";
  if (code === 93) return "\x1d";
  if (code === 94) return "\x1e";
  if (code === 95) return "\x1f";
  if (code === 63) return "\x7f";
  return undefined;
}

/**
 * Converts Kitty CSI-u and xterm modifyOtherKeys events into the legacy
 * sequences Ink already understands. Shift+Enter is intentionally left alone
 * because the composer has a dedicated matcher for it.
 */
export function normalizeKeyInput(raw: string): string {
  if (!raw.startsWith("\x1b")) return raw;

  const csi = /^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?)?u$/.exec(raw);
  if (csi) {
    const code = Number(csi[1]);
    const modifier = Number(csi[2] ?? "1");
    const { shift, alt, ctrl } = modifierBits(modifier);

    if (code === 27) return "\x1b";
    if (code === 9) return shift ? "\x1b[Z" : "\t";
    if (code === 13) return shift || alt || ctrl ? raw : "\r";
    if (code === 127) {
      if (ctrl) return "\x17";
      return shift || alt ? raw : "\x7f";
    }
    if (ctrl && !shift && !alt) {
      const control = controlByte(code);
      if (control) return control;
    }

    const arrow =
      code === 65 ? "A" : code === 66 ? "B" : code === 67 ? "C" : code === 68 ? "D" : undefined;
    if (arrow) return modifier === 1 ? `\x1b[${arrow}` : `\x1b[1;${modifier}${arrow}`;
    return raw;
  }

  const modifyOther = /^\x1b\[27;(\d+);(\d+)~$/.exec(raw);
  if (modifyOther) {
    const modifier = Number(modifyOther[1]);
    const code = Number(modifyOther[2]);
    const { shift, alt, ctrl } = modifierBits(modifier);
    if (code === 27) return "\x1b";
    if (code === 9) return shift ? "\x1b[Z" : "\t";
    if (code === 13) return shift || alt || ctrl ? raw : "\r";
    if (code === 127) return ctrl ? "\x17" : "\x7f";
  }

  if (raw === "\x1b[1;2Z") return "\x1b[Z";
  return raw;
}

/**
 * Patches Ink's input emitter once so every useInput listener receives the same
 * normalized sequence. Mouse and paste data are not touched.
 */
export function installKeyNormalizer(emitter?: InputEmitter): () => void {
  if (!emitter || typeof emitter.emit !== "function") return () => undefined;
  const key = emitter as object;
  if (patchedEmitters.has(key)) return () => undefined;

  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event: string | symbol, ...args: unknown[]): boolean => {
    if (event === "input" && args.length > 0 && typeof args[0] === "string") {
      const raw = args[0];
      const normalized = normalizeKeyInput(raw);
      if (normalized !== raw && isInputDebugEnabled()) {
        writeInputDebug(
          `normalizer raw=${JSON.stringify(raw)} normalized=${JSON.stringify(normalized)}`,
        );
      }
      args[0] = normalized;
    }
    return originalEmit(event, ...args);
  };

  patchedEmitters.add(key);
  return () => {
    emitter.emit = originalEmit as InputEmitter["emit"];
    patchedEmitters.delete(key);
  };
}
