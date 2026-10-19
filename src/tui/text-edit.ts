export interface TextEditKey {
  ctrl?: boolean;
  meta?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

export function isBackspaceKey(key: TextEditKey, input: string): boolean {
  // Ink maps the terminal DEL byte (\x7f) to `key.delete`, so treat both as
  // backward deletion to match terminal expectations.
  return Boolean(key.backspace || key.delete || input === "\x7f" || input === "\b");
}

export function isDeleteKey(key: TextEditKey, input: string): boolean {
  return Boolean(key.delete || input === "\x1b[3~");
}

export function isWordBackspaceKey(key: TextEditKey, input: string): boolean {
  return Boolean(
    (key.ctrl && (key.backspace || input === "w" || input === "h" || input === "backspace")) ||
      (key.meta && (key.backspace || input === "\x7f" || input === "\b")) ||
      input === "\x17" ||
      input === "\x08" ||
      input === "\x1f" ||
      input === "\x1b[127;5u" ||
      input === "[127;5u" ||
      input === "\x1b[27;5;127~" ||
      input === "[27;5;127~" ||
      input === "\x1b[27;5;8~" ||
      input === "[27;5;8~" ||
      input === "\x1b[8;5~" ||
      input === "[8;5~" ||
      input === "\x1b\x7f",
  );
}

export function isWordBackspaceSequence(sequence: string): boolean {
  return (
    sequence === "\x08" ||
    sequence === "\x17" ||
    sequence === "\x1b\x7f" ||
    sequence === "\x1b[127;5u" ||
    sequence === "\x1b[27;5;127~" ||
    sequence === "\x1b[27;5;8~" ||
    sequence === "\x1b[8;5~"
  );
}

export function isWordDeleteSequence(sequence: string): boolean {
  return (
    sequence === "\x1b[3;5~" ||
    sequence === "\x1b[3;3~" ||
    sequence === "\x1b[3;5u" ||
    sequence === "\x1b[3;3u"
  );
}

export function isForwardDeleteSequence(sequence: string): boolean {
  return sequence === "\x1b[3~" || sequence === "\x04";
}

export function isWordDeleteKey(key: TextEditKey, input: string): boolean {
  return Boolean(
    (key.ctrl && (key.delete || input === "delete")) ||
      (key.meta && (key.delete || input === "d")) ||
      input === "\x1b[3;5~" ||
      input === "[3;5~" ||
      input === "\x1b[3;3~" ||
      input === "[3;3~",
  );
}

export function clampCursor(value: string, cursor: number): number {
  return Math.max(0, Math.min(value.length, cursor));
}

export function insertTextAt(
  value: string,
  cursor: number,
  insert: string,
): { nextText: string; nextCursor: number } {
  const point = clampCursor(value, cursor);
  return {
    nextText: `${value.slice(0, point)}${insert}${value.slice(point)}`,
    nextCursor: point + insert.length,
  };
}

export function deleteCharacterBefore(
  value: string,
  cursor: number,
): { nextText: string; nextCursor: number } {
  const point = clampCursor(value, cursor);
  if (point <= 0) return { nextText: value, nextCursor: 0 };
  return {
    nextText: `${value.slice(0, point - 1)}${value.slice(point)}`,
    nextCursor: point - 1,
  };
}

export function deleteCharacterAfter(
  value: string,
  cursor: number,
): { nextText: string; nextCursor: number } {
  const point = clampCursor(value, cursor);
  if (point >= value.length) return { nextText: value, nextCursor: point };
  return {
    nextText: `${value.slice(0, point)}${value.slice(point + 1)}`,
    nextCursor: point,
  };
}

function isWordCharacter(char: string): boolean {
  return /[a-zA-Z0-9_]/.test(char);
}

function isSpace(char: string): boolean {
  return /\s/.test(char);
}

export function findPreviousWordStart(text: string, cursorPos: number): number {
  let target = Math.max(0, Math.min(text.length, cursorPos));

  while (target > 0 && isSpace(text[target - 1])) {
    target -= 1;
  }

  if (target > 0 && isWordCharacter(text[target - 1])) {
    while (target > 0 && isWordCharacter(text[target - 1])) {
      target -= 1;
    }
    return target;
  }

  while (target > 0 && !isSpace(text[target - 1]) && !isWordCharacter(text[target - 1])) {
    target -= 1;
  }
  while (target > 0 && isWordCharacter(text[target - 1])) {
    target -= 1;
  }

  return target;
}

export function findNextWordEnd(text: string, cursorPos: number): number {
  let target = Math.max(0, Math.min(text.length, cursorPos));

  while (target < text.length && isSpace(text[target])) {
    target += 1;
  }

  if (target < text.length && !isWordCharacter(text[target])) {
    while (target < text.length && !isSpace(text[target]) && !isWordCharacter(text[target])) {
      target += 1;
    }
  } else {
    while (target < text.length && isWordCharacter(text[target])) {
      target += 1;
    }
  }

  return target;
}

export function deletePreviousWord(
  text: string,
  cursorPos: number,
): { nextText: string; nextCursor: number } {
  if (cursorPos <= 0) return { nextText: text, nextCursor: 0 };
  let target = Math.max(0, Math.min(text.length, cursorPos));

  while (target > 0 && isSpace(text[target - 1])) {
    target -= 1;
  }

  if (target > 0 && !isWordCharacter(text[target - 1])) {
    while (target > 0 && !isSpace(text[target - 1]) && !isWordCharacter(text[target - 1])) {
      target -= 1;
    }
  } else {
    while (target > 0 && isWordCharacter(text[target - 1])) {
      target -= 1;
    }
  }

  const nextText = text.slice(0, target) + text.slice(cursorPos);
  return { nextText, nextCursor: target };
}

export function deleteNextWord(
  text: string,
  cursorPos: number,
): { nextText: string; nextCursor: number } {
  if (cursorPos >= text.length) return { nextText: text, nextCursor: cursorPos };
  const target = findNextWordEnd(text, cursorPos);
  const nextText = text.slice(0, cursorPos) + text.slice(target);
  return { nextText, nextCursor: cursorPos };
}
