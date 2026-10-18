import React from "react";
import { Box, Text, useInput } from "ink";
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

export interface FileAttachmentRef {
  raw: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  exists: boolean;
  tokens: number;
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
  placeholder?: string;
  historyFilePath?: string;
  disabled?: boolean;
  onSubmit?: (payload: PromptSubmitPayload) => void;
  onModeToggle?: () => void;
  onOpenHub?: () => void;
  onOpenPalette?: () => void;
  onOpenSessions?: () => void;
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
      const file = Bun.file(this.filePath);
      if (file.size > 0) {
        const text = file.text();
        // Since loadSync is non-async in constructor, read via standard fs or async promise handler
        void text.then((raw) => {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              this.history = parsed.filter((item): item is string => typeof item === "string");
            }
          } catch {
            this.history = [];
          }
        });
      }
    } catch {
      this.history = [];
    }
  }

  async load(): Promise<string[]> {
    try {
      const file = Bun.file(this.filePath);
      if (await file.exists()) {
        const raw = await file.text();
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.history = parsed.filter((item): item is string => typeof item === "string");
        }
      }
    } catch {
      this.history = [];
    }
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
      // Ignore write failures if directory is not writable.
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
    let exists = false;
    let tokens = 0;

    try {
      const file = Bun.file(fullPath);
      exists = await file.exists();
      if (exists) {
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
      // Omit files that fail reading.
    }
  }

  return blocks.join("\n\n");
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

export function PromptComposer(props: PromptComposerProps) {
  const {
    mode = "build",
    theme = getTheme("tokyonight"),
    repoRoot,
    placeholder = "Ketik instruksi, / untuk command, @ untuk file, # untuk simbol...",
    historyFilePath,
    disabled = false,
    onSubmit,
    onModeToggle,
    onOpenHub,
    onOpenPalette,
    onOpenSessions,
  } = props;

  const [text, setText] = React.useState("");
  const [cursorPos, setCursorPos] = React.useState(0);
  const [attachedFiles, setAttachedFiles] = React.useState<FileAttachmentRef[]>([]);
  const [historyManager] = React.useState(() => new PersistentCommandHistory(historyFilePath, repoRoot));

  const [autocompleteContext, setAutocompleteContext] = React.useState<TriggerContext | null>(null);
  const [autocompleteItems, setAutocompleteItems] = React.useState<AutocompleteItem[]>([]);
  const [autocompleteSelected, setAutocompleteSelected] = React.useState(0);

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

  const handleInsertAutocomplete = (item: AutocompleteItem): void => {
    if (!autocompleteContext) return;
    const before = text.slice(0, autocompleteContext.replaceStart);
    const after = text.slice(autocompleteContext.replaceEnd);
    const inserted = item.insertText;
    const nextText = `${before}${inserted}${after}`;
    const nextCursor = before.length + inserted.length;

    setText(nextText);
    setCursorPos(nextCursor);
    setAutocompleteContext(null);
    setAutocompleteItems([]);
  };

  const handleFinalSubmit = async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const lower = trimmed.toLowerCase();
    const ultrawork = /^(ulw|ultrawork)\b/.test(lower);
    const resolvedAttachments = await resolveFileAttachments(parseFileAttachments(trimmed), repoRoot);
    const injectedContext = await buildInjectedContext(resolvedAttachments, repoRoot);
    const fullText = injectedContext.length > 0 ? `${trimmed}\n\n${injectedContext}` : trimmed;

    await historyManager.append(trimmed);

    setText("");
    setCursorPos(0);
    setAttachedFiles([]);
    setAutocompleteContext(null);
    setAutocompleteItems([]);

    if (onSubmit) {
      onSubmit({
        rawText: trimmed,
        injectedContext: injectedContext.length > 0 ? injectedContext : undefined,
        fullText,
        ultrawork,
        attachments: resolvedAttachments,
      });
    }
  };

  useInput((input, key) => {
    if (disabled) return;

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

    if ((key.meta && input === "a") || input === "\u001ba") {
      onOpenHub?.();
      return;
    }

    if (key.ctrl && (input === "p" || input === "\x10")) {
      onOpenPalette?.();
      return;
    }

    if (key.ctrl && (input === "s" || input === "\x13")) {
      onOpenSessions?.();
      return;
    }

    const { line, col, lines } = getLineAndColumn(text, cursorPos);

    const isExplicitNewline =
      (key.return && key.shift) ||
      (key.return && key.meta) ||
      input === "\u001b\r";

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
      setText(`${before}\n${after}`);
      setCursorPos(before.length + 1);
      return;
    }

    if (key.return) {
      void handleFinalSubmit();
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

    if ((key.ctrl && input === "a") || (key as { home?: boolean }).home) {
      setCursorPos(getCursorOffset(lines, line, 0));
      return;
    }

    if ((key.ctrl && input === "e") || (key as { end?: boolean }).end) {
      setCursorPos(getCursorOffset(lines, line, lines[line].length));
      return;
    }

    if (key.ctrl && input === "w") {
      const before = text.slice(0, cursorPos);
      const after = text.slice(cursorPos);
      const lastWordMatch = /([a-zA-Z0-9_\-./\\]+|[^\s\w]+|\s+)\s*$/.exec(before);
      if (lastWordMatch) {
        const cutLength = lastWordMatch[0].length;
        const nextBefore = before.slice(0, -cutLength);
        setText(`${nextBefore}${after}`);
        setCursorPos(nextBefore.length);
      }
      return;
    }

    if (key.backspace) {
      if (cursorPos > 0) {
        const before = text.slice(0, cursorPos - 1);
        const after = text.slice(cursorPos);
        setText(`${before}${after}`);
        setCursorPos(cursorPos - 1);
      }
      return;
    }

    if (key.delete) {
      if (cursorPos < text.length) {
        const before = text.slice(0, cursorPos);
        const after = text.slice(cursorPos + 1);
        setText(`${before}${after}`);
      }
      return;
    }

    if (key.escape) {
      if (text.length > 0) {
        setText("");
        setCursorPos(0);
        historyManager.resetPointer();
      }
      return;
    }

    if (!key.ctrl && !key.meta && input.length > 0 && input >= " ") {
      const before = text.slice(0, cursorPos);
      const after = text.slice(cursorPos);
      setText(`${before}${input}${after}`);
      setCursorPos(cursorPos + input.length);
    }
  });

  const modeStyle = theme.modes[mode] ?? theme.modes.build;
  const { line: activeLine, col: activeCol, lines } = getLineAndColumn(text, cursorPos);
  const totalTokens = attachedFiles.reduce((sum, item) => sum + item.tokens, 0);

  return (
    <Box flexDirection="column" marginTop={0}>
      {autocompleteItems.length > 0 && autocompleteContext ? (
        <AutocompletePopup
          items={autocompleteItems}
          selectedIndex={autocompleteSelected}
          trigger={autocompleteContext.trigger}
          theme={theme}
          maxVisible={6}
        />
      ) : null}

      {attachedFiles.length > 0 ? (
        <Box flexDirection="row" gap={1} marginBottom={0} paddingX={1}>
          <Text bold color={theme.accent}>
            [LAMPIRAN FILE]:
          </Text>
          {attachedFiles.map((file) => (
            <Text
              key={file.raw}
              color={file.exists ? theme.modes.build.primary : theme.modes.ultrawork.secondary}
            >
              [{file.raw} ~{file.tokens} tok]
            </Text>
          ))}
          <Text dimColor>
            (Total ~{totalTokens} tok otomatis disuntikkan saat Enter)
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
              &gt;{" "}
            </Text>
            <Text dimColor>{placeholder}</Text>
          </Box>
        ) : (
          lines.map((lineContent, lineIndex) => {
            const isCurrentLine = lineIndex === activeLine;
            const prefix = lines.length > 1 ? `${lineIndex + 1} | ` : "> ";

            if (!isCurrentLine) {
              return (
                <Box key={`line-${lineIndex}`}>
                  <Text color={modeStyle.secondary} dimColor>
                    {prefix}
                  </Text>
                  <Text>{lineContent}</Text>
                </Box>
              );
            }

            const beforeCursor = lineContent.slice(0, activeCol);
            const cursorChar = lineContent[activeCol] ?? " ";
            const afterCursor = lineContent.slice(activeCol + 1);

            return (
              <Box key={`line-${lineIndex}`}>
                <Text color={modeStyle.primary} bold>
                  {prefix}
                </Text>
                <Text>{beforeCursor}</Text>
                <Text inverse bold color={modeStyle.primary}>
                  {cursorChar}
                </Text>
                <Text>{afterCursor}</Text>
              </Box>
            );
          })
        )}
      </Box>

      <Box justifyContent="space-between" paddingX={1}>
        <Text dimColor>
          Tab: Mode | @: Lampirkan File | /: Command | Ctrl+P: Palette | Alt+A: Subagents | Ctrl+O: Detail Tool
        </Text>
        <Text dimColor>
          Shift+Enter / \+Enter: Baris Baru | Enter: Kirim
        </Text>
      </Box>
    </Box>
  );
}
