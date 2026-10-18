import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { Box, Text, useInput, useStdin } from "ink";
import { resolve } from "node:path";

import type { AgentMode } from "../types/schema";
import { formatLine, readText, splitLines } from "../tools/hashline-edit";
import {
  AutocompletePopup,
  queryAutocomplete,
  type AutocompleteItem,
  type TriggerContext,
} from "./autocomplete";
import { getTheme, type Theme } from "./theme";
import { formatTokenCount } from "./format";

export interface FileAttachmentRef {
  raw: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  exists: boolean;
  tokens: number;
  kind: "text" | "image";
  mimeType?: string;
  base64?: string;
  error?: string;
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 4;

export function imageMimeType(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return undefined;
  return IMAGE_MIME_BY_EXTENSION[filePath.slice(dot + 1).toLowerCase()];
}

export interface PromptSubmitPayload {
  rawText: string;
  injectedContext?: string;
  fullText: string;
  ultrawork: boolean;
  attachments: FileAttachmentRef[];
}

export interface PromptComposerProps {
  mode?: AgentMode;
  theme?: Theme;
  repoRoot?: string;
  width?: number;
  placeholder?: string;
  historyFilePath?: string;
  disabled?: boolean;
  streaming?: boolean;
  onSubmit?: (payload: PromptSubmitPayload) => void;
  onModeToggle?: () => void;
  onOpenHub?: () => void;
  onOpenPalette?: () => void;
  onOpenSessions?: () => void;
  onOpenHelp?: () => void;
  onLayoutRows?: (rows: number) => void;
}

export class PersistentCommandHistory {
  private history: string[] = [];
  private readonly filePath: string;
  private pointer = -1;
  private currentDraft = "";

  constructor(filePath?: string, repoRoot?: string) {
    const root = repoRoot ?? globalThis.process.cwd();
    this.filePath = filePath ?? resolve(root, ".agent", "history.json");
    this.loadSync();
  }

  loadSync(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = readFileSync(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.history = parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      this.history = [];
    }
  }

  async load(): Promise<string[]> {
    this.loadSync();
    return this.history;
  }

  async append(command: string): Promise<void> {
    const trimmed = command.trim();
    if (!trimmed) return;

    if (this.history.length > 0 && this.history[this.history.length - 1] === trimmed) {
      this.resetPointer();
      return;
    }

    this.history.push(trimmed);
    if (this.history.length > 500) {
      this.history = this.history.slice(-500);
    }
    this.resetPointer();

    try {
      await Bun.write(this.filePath, JSON.stringify(this.history, null, 2));
    } catch {
      // History is best effort and never blocks sending a prompt.
    }
  }

  getPrevious(currentDraft: string): string | null {
    if (this.history.length === 0) return null;

    if (this.pointer === -1) {
      this.currentDraft = currentDraft;
      this.pointer = this.history.length - 1;
      return this.history[this.pointer] ?? null;
    }

    if (this.pointer > 0) {
      this.pointer -= 1;
      return this.history[this.pointer] ?? null;
    }

    return this.history[0] ?? null;
  }

  getNext(): { text: string; isDraft: boolean } | null {
    if (this.pointer === -1) return null;

    if (this.pointer < this.history.length - 1) {
      this.pointer += 1;
      return { text: this.history[this.pointer] ?? "", isDraft: false };
    }

    this.pointer = -1;
    return { text: this.currentDraft, isDraft: true };
  }

  resetPointer(): void {
    this.pointer = -1;
    this.currentDraft = "";
  }

  getEntries(): string[] {
    return [...this.history];
  }
}

export function parseFileAttachments(text: string): Array<{ raw: string; filePath: string; startLine?: number; endLine?: number }> {
  const matches: Array<{ raw: string; filePath: string; startLine?: number; endLine?: number }> = [];
  const regex = /@([a-zA-Z0-9_\-./\\]+)(?::(\d+)(?:-(\d+))?)?/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const filePath = match[1];
    const startLine = match[2] ? Number.parseInt(match[2], 10) : undefined;
    const endLine = match[3] ? Number.parseInt(match[3], 10) : undefined;

    if (filePath && !matches.some((existing) => existing.raw === raw)) {
      matches.push({ raw, filePath, startLine, endLine });
    }
  }

  return matches;
}

export async function resolveFileAttachments(
  attachments: Array<{ raw: string; filePath: string; startLine?: number; endLine?: number }>,
  repoRoot?: string,
): Promise<FileAttachmentRef[]> {
  const root = repoRoot ?? globalThis.process.cwd();
  const results: FileAttachmentRef[] = [];

  for (const item of attachments) {
    const fullPath = resolve(root, item.filePath);
    const mimeType = imageMimeType(item.filePath);
    const kind = mimeType ? "image" : "text";
    let exists = false;
    let tokens = 0;

    try {
      const file = Bun.file(fullPath);
      exists = await file.exists();
      if (exists && kind === "text") {
        if (item.startLine !== undefined) {
          const content = await file.text();
          const lines = splitLines(content);
          const start = Math.max(1, item.startLine);
          const end = Math.min(lines.length, item.endLine ?? item.startLine);
          const sliceText = lines.slice(start - 1, end).join("\n");
          tokens = Math.max(1, Math.ceil(sliceText.length / 4));
        } else {
          tokens = Math.max(1, Math.ceil(file.size / 4));
        }
      }
    } catch {
      exists = false;
      tokens = 0;
    }

    results.push({
      raw: item.raw,
      filePath: item.filePath,
      startLine: item.startLine,
      endLine: item.endLine,
      exists,
      tokens,
      kind,
      mimeType,
    });
  }

  return results;
}

export async function buildInjectedContext(
  attachments: FileAttachmentRef[],
  repoRoot?: string,
): Promise<string> {
  const root = repoRoot ?? globalThis.process.cwd();
  const blocks: string[] = [];

  for (const item of attachments) {
    if (item.kind === "image") continue;
    if (!item.exists) continue;
    const fullPath = resolve(root, item.filePath);

    try {
      const content = await readText(fullPath);
      const allLines = splitLines(content);
      const start = Math.max(1, item.startLine ?? 1);
      const end = Math.min(allLines.length, item.endLine ?? (item.startLine !== undefined ? item.startLine : allLines.length));

      if (start > allLines.length) continue;

      const formattedLines: string[] = [];
      for (let lineIndex = start - 1; lineIndex < end; lineIndex += 1) {
        const lineNum = lineIndex + 1;
        const lineContent = allLines[lineIndex] ?? "";
        formattedLines.push(formatLine(lineNum, lineContent));
      }

      const rangeLabel = item.startLine ? `:${item.startLine}${item.endLine ? `-${item.endLine}` : ""}` : "";
      blocks.push(
        [
          `--- File Context: ${item.filePath}${rangeLabel} (${formattedLines.length} lines) ---`,
          ...formattedLines,
        ].join("\n"),
      );
    } catch {
      // Skip files that cannot be read.
    }
  }

  return blocks.join("\n\n");
}

export async function loadImageAttachments(
  attachments: FileAttachmentRef[],
  repoRoot?: string,
): Promise<FileAttachmentRef[]> {
  const root = repoRoot ?? globalThis.process.cwd();
  const results: FileAttachmentRef[] = [];
  let imageCount = 0;

  for (const item of attachments) {
    if (item.kind !== "image") {
      results.push(item);
      continue;
    }
    if (!item.exists) {
      results.push({ ...item, error: "file not found" });
      continue;
    }
    if (imageCount >= MAX_IMAGES_PER_MESSAGE) {
      results.push({ ...item, error: `only ${MAX_IMAGES_PER_MESSAGE} images per message` });
      continue;
    }

    try {
      const file = Bun.file(resolve(root, item.filePath));
      if (file.size > MAX_IMAGE_BYTES) {
        results.push({
          ...item,
          error: `image is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`,
        });
        continue;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      results.push({ ...item, base64: Buffer.from(bytes).toString("base64") });
      imageCount += 1;
    } catch (error) {
      results.push({ ...item, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return results;
}

export function getLineAndColumn(text: string, cursor: number): { line: number; col: number; lines: string[] } {
  const lines = text.split("\n");
  let remaining = Math.max(0, Math.min(text.length, cursor));

  for (let index = 0; index < lines.length; index += 1) {
    const lineLen = lines[index].length;
    if (remaining <= lineLen) {
      return { line: index, col: remaining, lines };
    }
    remaining -= lineLen + 1;
  }

  const lastIndex = Math.max(0, lines.length - 1);
  return { line: lastIndex, col: lines[lastIndex]?.length ?? 0, lines };
}

export function getCursorOffset(lines: string[], targetLine: number, targetCol: number): number {
  let offset = 0;
  const clampedLine = Math.max(0, Math.min(lines.length - 1, targetLine));

  for (let index = 0; index < clampedLine; index += 1) {
    offset += lines[index].length + 1;
  }

  const clampedCol = Math.max(0, Math.min(lines[clampedLine]?.length ?? 0, targetCol));
  return offset + clampedCol;
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

export function deletePreviousWord(text: string, cursorPos: number): { nextText: string; nextCursor: number } {
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

export function deleteNextWord(text: string, cursorPos: number): { nextText: string; nextCursor: number } {
  if (cursorPos >= text.length) return { nextText: text, nextCursor: cursorPos };
  const target = findNextWordEnd(text, cursorPos);
  const nextText = text.slice(0, cursorPos) + text.slice(target);
  return { nextText, nextCursor: cursorPos };
}

export function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code === 0x200d) return 0;
  if (code >= 0x0300 && code <= 0x036f) return 0;

  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd);

  return wide ? 2 : 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charDisplayWidth(char);
  return width;
}

export function splitLineAtCursor(line: string, col: number): { before: string; cursorChar: string; after: string } {
  const chars = Array.from(line);
  let consumed = 0;
  let pointIndex = 0;

  for (const char of chars) {
    if (consumed >= col) break;
    consumed += char.length;
    pointIndex += 1;
  }

  const cursorChar = chars[pointIndex];
  const before = chars.slice(0, pointIndex).join("");
  const after = chars.slice(pointIndex + (cursorChar ? 1 : 0)).join("");
  return { before, cursorChar: cursorChar ?? " ", after };
}

function normalizeInsertedText(input: string): string {
  return input.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
}

export function PromptComposer(props: PromptComposerProps) {
  const {
    mode = "build",
    theme = getTheme("tokyonight"),
    repoRoot,
    width,
    placeholder = "Ask Orchivox, / for commands, @ for files, $ for skills",
    historyFilePath,
    disabled = false,
    streaming = false,
    onSubmit,
    onModeToggle,
    onOpenHub,
    onOpenPalette,
    onOpenSessions,
    onOpenHelp,
    onLayoutRows,
  } = props;

  const [text, setText] = React.useState("");
  const [cursorPos, setCursorPos] = React.useState(0);
  const [attachedFiles, setAttachedFiles] = React.useState<FileAttachmentRef[]>([]);
  const [historyManager] = React.useState(() => new PersistentCommandHistory(historyFilePath, repoRoot));

  const [autocompleteContext, setAutocompleteContext] = React.useState<TriggerContext | null>(null);
  const [autocompleteItems, setAutocompleteItems] = React.useState<AutocompleteItem[]>([]);
  const [autocompleteSelected, setAutocompleteSelected] = React.useState(0);

  const { internal_eventEmitter } = useStdin();
  const lastRawInputRef = React.useRef<string>("");
  const undoStack = React.useRef<Array<{ text: string; cursor: number }>>([]);
  const redoStack = React.useRef<Array<{ text: string; cursor: number }>>([]);

  React.useEffect(() => {
    const emitter = internal_eventEmitter as
      | { prependListener?: (event: string, listener: (data: Buffer | string) => void) => void; removeListener?: (event: string, listener: (data: Buffer | string) => void) => void }
      | undefined;
    const onRaw = (data: Buffer | string) => {
      lastRawInputRef.current = typeof data === "string" ? data : data.toString("utf8");
    };
    emitter?.prependListener?.("input", onRaw);
    return () => {
      emitter?.removeListener?.("input", onRaw);
    };
  }, [internal_eventEmitter]);

  React.useEffect(() => {
    let cancelled = false;
    const rawAttachments = parseFileAttachments(text);

    if (rawAttachments.length === 0) {
      setAttachedFiles([]);
      return;
    }

    void resolveFileAttachments(rawAttachments, repoRoot).then((resolved) => {
      if (!cancelled) {
        setAttachedFiles(resolved);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [text, repoRoot]);

  React.useEffect(() => {
    let cancelled = false;

    void queryAutocomplete(text, cursorPos, repoRoot).then((result) => {
      if (cancelled) return;
      if (result && result.items.length > 0) {
        setAutocompleteContext(result.context);
        setAutocompleteItems(result.items);
        setAutocompleteSelected(0);
      } else {
        setAutocompleteContext(null);
        setAutocompleteItems([]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [text, cursorPos, repoRoot]);

  const commitEdit = (nextText: string, nextCursor: number): void => {
    if (nextText === text && nextCursor === cursorPos) return;
    undoStack.current.push({ text, cursor: cursorPos });
    if (undoStack.current.length > 200) undoStack.current.shift();
    redoStack.current = [];
    setText(nextText);
    setCursorPos(nextCursor);
  };

  const undo = (): void => {
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push({ text, cursor: cursorPos });
    setText(previous.text);
    setCursorPos(Math.min(previous.cursor, previous.text.length));
  };

  const redo = (): void => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push({ text, cursor: cursorPos });
    setText(next.text);
    setCursorPos(Math.min(next.cursor, next.text.length));
  };

  const handleInsertAutocomplete = (item: AutocompleteItem): void => {
    if (!autocompleteContext) return;
    const before = text.slice(0, autocompleteContext.replaceStart);
    const after = text.slice(autocompleteContext.replaceEnd);
    const inserted = item.insertText;
    const nextText = `${before}${inserted}${after}`;
    const nextCursor = before.length + inserted.length;

    commitEdit(nextText, nextCursor);
    setAutocompleteContext(null);
    setAutocompleteItems([]);
  };

  const handleFinalSubmit = async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const lower = trimmed.toLowerCase();
    const ultrawork = /^(ulw|ultrawork)\b/.test(lower);
    const resolvedAttachments = await resolveFileAttachments(parseFileAttachments(trimmed), repoRoot);
    const loadedAttachments = await loadImageAttachments(resolvedAttachments, repoRoot);
    const injectedContext = await buildInjectedContext(loadedAttachments, repoRoot);
    const fullText = injectedContext.length > 0 ? `${trimmed}\n\n${injectedContext}` : trimmed;

    await historyManager.append(trimmed);

    setText("");
    setCursorPos(0);
    setAttachedFiles([]);
    setAutocompleteContext(null);
    setAutocompleteItems([]);
    undoStack.current = [];
    redoStack.current = [];

    if (onSubmit) {
      onSubmit({
        rawText: trimmed,
        injectedContext: injectedContext.length > 0 ? injectedContext : undefined,
        fullText,
        ultrawork,
        attachments: loadedAttachments,
      });
    }
  };

  useInput((input, key) => {
    if (disabled) return;

    const raw = lastRawInputRef.current;
    const sequence = raw.startsWith("\x1b") ? raw : input.length > 0 ? input : raw;

    if (autocompleteItems.length > 0 && autocompleteContext) {
      if (key.upArrow) {
        setAutocompleteSelected((prev) => (prev > 0 ? prev - 1 : autocompleteItems.length - 1));
        return;
      }
      if (key.downArrow) {
        setAutocompleteSelected((prev) => (prev < autocompleteItems.length - 1 ? prev + 1 : 0));
        return;
      }
      if (key.escape) {
        setAutocompleteContext(null);
        setAutocompleteItems([]);
        return;
      }
      if (key.tab || key.return) {
        const selected = autocompleteItems[autocompleteSelected];
        if (selected) {
          handleInsertAutocomplete(selected);
          return;
        }
      }
    }

    if (key.tab && !autocompleteContext) {
      onModeToggle?.();
      return;
    }

    if ((key.meta && input === "a") || sequence === "\u001ba") {
      onOpenHub?.();
      return;
    }

    if ((key.ctrl && (input === "p" || sequence === "\x10")) || sequence === "\x10") {
      onOpenPalette?.();
      return;
    }

    if ((key.ctrl && (input === "s" || sequence === "\x13")) || sequence === "\x13") {
      onOpenSessions?.();
      return;
    }

    if ((key.ctrl && (input === "g" || sequence === "\x07")) || sequence === "\x07") {
      onOpenHelp?.();
      return;
    }

    const { line, col, lines } = getLineAndColumn(text, cursorPos);

    const isExplicitNewline =
      (key.return && key.shift) ||
      (key.return && key.meta) ||
      (key.return && key.ctrl) ||
      sequence === "\u001b\r" ||
      sequence === "\x1b[13;2u" ||
      sequence === "\x1b[27;2;13~" ||
      sequence === "\x1b[13;5u" ||
      sequence === "\x1b[27;5;13~";

    const isBackslashNewline =
      key.return &&
      cursorPos > 0 &&
      text[cursorPos - 1] === "\\";

    if (isExplicitNewline || isBackslashNewline) {
      let before = text.slice(0, cursorPos);
      if (isBackslashNewline) {
        before = before.slice(0, -1);
      }
      const after = text.slice(cursorPos);
      commitEdit(`${before}\n${after}`, before.length + 1);
      return;
    }

    if (key.return) {
      void handleFinalSubmit();
      return;
    }

    const isUndo = (key.ctrl && (input === "z" || sequence === "\x1a")) || sequence === "\x1a";
    if (isUndo) {
      if (key.shift) redo();
      else undo();
      return;
    }

    const isRedo = (key.ctrl && (input === "y" || sequence === "\x19")) || sequence === "\x19";
    if (isRedo) {
      redo();
      return;
    }

    const isWordMoveLeft =
      (key.ctrl && key.leftArrow) ||
      (key.meta && input === "b") ||
      sequence === "\x1b[1;5D" ||
      sequence === "\x1b[5D" ||
      sequence === "\x1bb";
    if (isWordMoveLeft) {
      setCursorPos(findPreviousWordStart(text, cursorPos));
      return;
    }

    const isWordMoveRight =
      (key.ctrl && key.rightArrow) ||
      (key.meta && input === "f") ||
      sequence === "\x1b[1;5C" ||
      sequence === "\x1b[5C" ||
      sequence === "\x1bf";
    if (isWordMoveRight) {
      setCursorPos(findNextWordEnd(text, cursorPos));
      return;
    }

    if (key.upArrow) {
      if (line > 0) {
        const nextCol = Math.min(col, lines[line - 1].length);
        setCursorPos(getCursorOffset(lines, line - 1, nextCol));
      } else {
        const prevCommand = historyManager.getPrevious(text);
        if (prevCommand !== null) {
          setText(prevCommand);
          setCursorPos(prevCommand.length);
        }
      }
      return;
    }

    if (key.downArrow) {
      if (line < lines.length - 1) {
        const nextCol = Math.min(col, lines[line + 1].length);
        setCursorPos(getCursorOffset(lines, line + 1, nextCol));
      } else {
        const nextEntry = historyManager.getNext();
        if (nextEntry !== null) {
          setText(nextEntry.text);
          setCursorPos(nextEntry.text.length);
        }
      }
      return;
    }

    if (key.leftArrow) {
      setCursorPos((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.rightArrow) {
      setCursorPos((prev) => Math.min(text.length, prev + 1));
      return;
    }

    if ((key.ctrl && (input === "a" || sequence === "\x01")) || (key as { home?: boolean }).home || sequence === "\x1b[H" || sequence === "\x1b[1~") {
      setCursorPos(getCursorOffset(lines, line, 0));
      return;
    }

    if ((key.ctrl && (input === "e" || sequence === "\x05")) || (key as { end?: boolean }).end || sequence === "\x1b[F" || sequence === "\x1b[4~") {
      setCursorPos(getCursorOffset(lines, line, lines[line].length));
      return;
    }

    if ((key.ctrl && (input === "u" || sequence === "\x15")) || sequence === "\x15") {
      const lineStart = getCursorOffset(lines, line, 0);
      commitEdit(`${text.slice(0, lineStart)}${text.slice(cursorPos)}`, lineStart);
      return;
    }

    if ((key.ctrl && (input === "k" || sequence === "\x0b")) || sequence === "\x0b") {
      const lineEnd = getCursorOffset(lines, line, lines[line].length);
      commitEdit(`${text.slice(0, cursorPos)}${text.slice(lineEnd)}`, cursorPos);
      return;
    }

    const isForwardWordDelete =
      (key.ctrl && key.delete) ||
      sequence === "\x1b[3;5~" ||
      sequence === "\x1b[3;3~" ||
      (key.meta && (input === "d" || sequence === "\x1bd"));
    if (isForwardWordDelete) {
      const { nextText, nextCursor } = deleteNextWord(text, cursorPos);
      commitEdit(nextText, nextCursor);
      return;
    }

    const isWordBackspace =
      (key.ctrl && (key.backspace || input === "w" || input === "h")) ||
      (key.meta && key.backspace) ||
      sequence === "\x17" ||
      sequence === "\x08" ||
      sequence === "\b" ||
      sequence === "\x1f" ||
      sequence === "\x1b[127;5u" ||
      sequence === "\x1b[27;5;127~" ||
      sequence === "\x1b[27;5;8~" ||
      sequence === "\x1b[8;5~" ||
      sequence === "\x1b\x7f";
    if (isWordBackspace) {
      const { nextText, nextCursor } = deletePreviousWord(text, cursorPos);
      commitEdit(nextText, nextCursor);
      return;
    }

    const isForwardDelete =
      sequence === "\x1b[3~" ||
      sequence === "\x04" ||
      (key.ctrl && input === "d");
    if (isForwardDelete) {
      if (cursorPos < text.length) {
        commitEdit(`${text.slice(0, cursorPos)}${text.slice(cursorPos + 1)}`, cursorPos);
      }
      return;
    }

    const isBackspace =
      key.backspace ||
      sequence === "\x7f";
    if (isBackspace) {
      if (cursorPos > 0) {
        commitEdit(`${text.slice(0, cursorPos - 1)}${text.slice(cursorPos)}`, cursorPos - 1);
      }
      return;
    }

    if (key.escape) {
      if (!streaming && text.length > 0) {
        commitEdit("", 0);
        historyManager.resetPointer();
      }
      return;
    }

    const isPrintable =
      !key.ctrl &&
      !key.meta &&
      input.length > 0 &&
      input >= " " &&
      input !== "\x7f" &&
      !input.startsWith("\x1b");

    if (isPrintable) {
      const inserted = normalizeInsertedText(input);
      commitEdit(`${text.slice(0, cursorPos)}${inserted}${text.slice(cursorPos)}`, cursorPos + inserted.length);
    }
  });

  const modeStyle = theme.modes[mode] ?? theme.modes.build;
  const { line: activeLine, col: activeCol, lines } = getLineAndColumn(text, cursorPos);
  const totalTokens = attachedFiles.reduce((sum, item) => sum + item.tokens, 0);
  const imageCount = attachedFiles.filter((item) => item.kind === "image").length;

  const popupVisible = autocompleteItems.length > 0 && autocompleteContext !== null;
  const popupRows = popupVisible ? Math.min(6, autocompleteItems.length) + 4 : 0;
  const attachmentRows = attachedFiles.length > 0 ? 1 : 0;
  const layoutRows = popupRows + attachmentRows + lines.length + 2 + 1;

  React.useLayoutEffect(() => {
    onLayoutRows?.(layoutRows);
  }, [layoutRows, onLayoutRows]);

  return (
    <Box flexDirection="column" marginTop={0}>
      {autocompleteItems.length > 0 && autocompleteContext ? (
        <AutocompletePopup
          items={autocompleteItems}
          selectedIndex={autocompleteSelected}
          trigger={autocompleteContext.trigger}
          theme={theme}
          maxVisible={6}
          width={width}
        />
      ) : null}

      {attachedFiles.length > 0 ? (
        <Box flexDirection="row" gap={1} marginBottom={0} paddingX={1}>
          <Text bold color={theme.accent}>
            Attached:
          </Text>
          {attachedFiles.slice(0, 3).map((file) => (
            <Text
              key={file.raw}
              color={file.exists ? theme.modes.build.primary : theme.badge.error}
            >
              {file.raw.length > 28 ? `${file.raw.slice(0, 25)}...` : file.raw}{" "}
              {file.kind === "image" ? "(image)" : `(~${file.tokens} tok)`}
            </Text>
          ))}
          {attachedFiles.length > 3 ? (
            <Text color={theme.muted}>+{attachedFiles.length - 3} more</Text>
          ) : null}
          <Text color={theme.muted}>
            (~{formatTokenCount(totalTokens)} tokens
            {imageCount > 0 ? ` + ${imageCount} image${imageCount === 1 ? "" : "s"}` : ""} on Enter)
          </Text>
        </Box>
      ) : null}

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={modeStyle.primary}
        paddingX={1}
      >
        {lines.length === 1 && lines[0].length === 0 ? (
          <Box>
            <Text color={modeStyle.primary} bold>
              ❯{" "}
            </Text>
            <Text color={theme.muted}>{placeholder}</Text>
          </Box>
        ) : (
          lines.map((lineContent, lineIndex) => {
            const isCurrentLine = lineIndex === activeLine;
            const prefix = lines.length > 1 ? `${lineIndex + 1} │ ` : "❯ ";

            if (!isCurrentLine) {
              return (
                <Box key={`line-${lineIndex}`}>
                  <Text color={theme.border.passive}>
                    {prefix}
                  </Text>
                  <Text color={theme.text}>{lineContent}</Text>
                </Box>
              );
            }

            const { before, cursorChar, after } = splitLineAtCursor(lineContent, activeCol);

            return (
              <Box key={`line-${lineIndex}`}>
                <Text color={modeStyle.primary} bold>
                  {prefix}
                </Text>
                <Text color={theme.text}>{before}</Text>
                <Text inverse bold color={modeStyle.primary}>
                  {cursorChar}
                </Text>
                <Text color={theme.text}>{after}</Text>
              </Box>
            );
          })
        )}
      </Box>

      <Box paddingX={1}>
        <Text color={theme.muted}>
          Tab mode · / commands · @ files · $ skills · Ctrl+P palette · Enter send · Shift+Enter newline
        </Text>
      </Box>
    </Box>
  );
}
