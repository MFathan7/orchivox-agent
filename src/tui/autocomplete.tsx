import React from "react";
import { Box, Text } from "ink";
import { readdir } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";

import { extractDeclarations, detectLanguage, type SourceLanguage } from "../ide/ast-compress";
import { readText } from "../tools/hashline-edit";
import { CustomCommandEngine } from "../agent/custom-commands";
import { SpecialistAgentRegistry } from "../agent/specialist-agents";
import { getTheme, type Theme } from "./theme";

export type AutocompleteTrigger = "command" | "file" | "symbol";

export interface AutocompleteItem {
  id: string;
  trigger: AutocompleteTrigger;
  label: string;
  insertText: string;
  description?: string;
  detail?: string;
  kind?: string;
  score?: number;
}

export interface FuzzyMatchResult {
  score: number;
  matches: number[];
}

export interface TriggerContext {
  trigger: AutocompleteTrigger;
  query: string;
  replaceStart: number;
  replaceEnd: number;
  linePrefix: string;
}

export interface AutocompletePopupProps {
  items: AutocompleteItem[];
  selectedIndex: number;
  trigger: AutocompleteTrigger;
  theme?: Theme;
  maxVisible?: number;
  title?: string;
}

export const BUILTIN_SLASH_COMMANDS: Array<{ name: string; args?: string; description: string }> = [
  { name: "/undo", description: "Batalkan perubahan file ke snapshot sebelumnya" },
  { name: "/redo", description: "Terapkan kembali snapshot yang dibatalkan" },
  { name: "/commit", description: "Pecah perubahan git menjadi atomic commit terstruktur" },
  { name: "/compact", description: "Ringkas riwayat percakapan untuk menghemat context window" },
  { name: "/plugins", description: "Tampilkan daftar plugin agent yang sedang aktif" },
  { name: "/collab", description: "Buka sesi siaran kolaborasi relay terminal" },
  { name: "/clear", description: "Bersihkan layar riwayat chat" },
  { name: "/mode", args: "[plan|build|ultrawork]", description: "Ganti mode kerja agent" },
  { name: "/theme", args: "[tokyonight|catppuccin|gruvbox|monochrome]", description: "Ganti tema visual terminal" },
  { name: "/help", description: "Tampilkan panduan perintah dan tombol shortcut" },
];

const IGNORED_SCAN_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".agent/memory.db",
  ".next",
  ".turbo",
  "build",
  "coverage",
]);

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

let cachedFiles: CacheEntry<string[]> | undefined;
let cachedSymbols: CacheEntry<AutocompleteItem[]> | undefined;
let cachedCommands: CacheEntry<AutocompleteItem[]> | undefined;

const CACHE_TTL_FILES_MS = 10_000;
const CACHE_TTL_SYMBOLS_MS = 30_000;
const CACHE_TTL_COMMANDS_MS = 15_000;

export function scoreFuzzyMatch(query: string, candidate: string): FuzzyMatchResult | null {
  if (query.length === 0) {
    return { score: 1, matches: [] };
  }

  const lowerQuery = query.toLowerCase();
  const lowerCandidate = candidate.toLowerCase();

  if (lowerQuery === lowerCandidate) {
    return {
      score: 2000 - Math.min(candidate.length, 100),
      matches: Array.from({ length: candidate.length }, (_, index) => index),
    };
  }

  if (lowerCandidate.startsWith(lowerQuery)) {
    return {
      score: 1200 - Math.min(candidate.length, 100),
      matches: Array.from({ length: query.length }, (_, index) => index),
    };
  }

  const substringIndex = lowerCandidate.indexOf(lowerQuery);
  if (substringIndex !== -1) {
    const isBoundary =
      substringIndex === 0 ||
      " /_.-#@:".includes(candidate[substringIndex - 1] ?? "");
    const boundaryBonus = isBoundary ? 300 : 100;
    return {
      score: 800 + boundaryBonus - substringIndex * 5 - Math.min(candidate.length, 100),
      matches: Array.from({ length: query.length }, (_, index) => substringIndex + index),
    };
  }

  const matches: number[] = [];
  let queryIndex = 0;
  let score = 0;
  let consecutiveMatches = 0;
  let prevCandidateIndex = -2;

  for (let candIndex = 0; candIndex < candidate.length && queryIndex < query.length; candIndex += 1) {
    if (lowerCandidate[candIndex] === lowerQuery[queryIndex]) {
      matches.push(candIndex);

      if (candIndex === prevCandidateIndex + 1) {
        consecutiveMatches += 1;
        score += 25 * consecutiveMatches;
      } else {
        consecutiveMatches = 0;
        score += 10;
      }

      const isWordStart =
        candIndex === 0 ||
        " /_.-#@:".includes(candidate[candIndex - 1] ?? "") ||
        (candidate[candIndex] >= "A" && candidate[candIndex] <= "Z" && candidate[candIndex - 1] >= "a" && candidate[candIndex - 1] <= "z");
      if (isWordStart) {
        score += 40;
      }

      prevCandidateIndex = candIndex;
      queryIndex += 1;
    }
  }

  if (queryIndex < query.length) {
    return null;
  }

  const span = matches[matches.length - 1] - matches[0] + 1;
  const spreadPenalty = Math.max(0, span - query.length) * 3;
  const finalScore = Math.max(1, score - spreadPenalty - Math.min(candidate.length, 100));

  return { score: finalScore, matches };
}

export function filterFuzzy<T>(
  query: string,
  items: T[],
  getCandidateText: (item: T) => string,
  limit = 40,
): Array<{ item: T; score: number; matches: number[] }> {
  const scored: Array<{ item: T; score: number; matches: number[] }> = [];

  for (const item of items) {
    const text = getCandidateText(item);
    const result = scoreFuzzyMatch(query, text);
    if (result !== null) {
      scored.push({ item, score: result.score, matches: result.matches });
    }
  }

  scored.sort((first, second) => second.score - first.score);
  return scored.slice(0, limit);
}

export function detectTriggerContext(text: string, cursorPos: number): TriggerContext | null {
  const safeCursor = Math.max(0, Math.min(text.length, cursorPos));
  const lastNewline = text.lastIndexOf("\n", safeCursor - 1);
  const lineStart = lastNewline === -1 ? 0 : lastNewline + 1;
  const linePrefix = text.slice(lineStart, safeCursor);

  if (linePrefix.startsWith("/")) {
    if (linePrefix.includes(" ")) {
      return null;
    }
    const query = linePrefix.slice(1);
    return {
      trigger: "command",
      query,
      replaceStart: lineStart,
      replaceEnd: safeCursor,
      linePrefix,
    };
  }

  const atMatch = /@([^\s]*)$/.exec(linePrefix);
  if (atMatch) {
    const query = atMatch[1];
    return {
      trigger: "file",
      query,
      replaceStart: safeCursor - atMatch[0].length,
      replaceEnd: safeCursor,
      linePrefix,
    };
  }

  const hashMatch = /#([^\s]*)$/.exec(linePrefix);
  if (hashMatch) {
    const query = hashMatch[1];
    return {
      trigger: "symbol",
      query,
      replaceStart: safeCursor - hashMatch[0].length,
      replaceEnd: safeCursor,
      linePrefix,
    };
  }

  return null;
}

export async function fetchSlashCommands(repoRoot?: string): Promise<AutocompleteItem[]> {
  const now = Date.now();
  if (cachedCommands && now - cachedCommands.timestamp < CACHE_TTL_COMMANDS_MS) {
    return cachedCommands.data;
  }

  const items: AutocompleteItem[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
    id: `cmd:${command.name}`,
    trigger: "command",
    label: command.name,
    insertText: `${command.name} `,
    detail: command.args,
    description: command.description,
    kind: "command",
  }));

  const root = repoRoot ?? globalThis.process.cwd();
  const engine = new CustomCommandEngine({ repoRoot: root });
  try {
    const customList = await engine.listCommands();
    for (const cmd of customList) {
      items.push({
        id: `custom-cmd:/${cmd.name}`,
        trigger: "command",
        label: `/${cmd.name}`,
        insertText: `/${cmd.name} `,
        detail: cmd.frontmatter.agent ? `[@${cmd.frontmatter.agent}]` : "(custom)",
        description: cmd.frontmatter.description ?? "Custom markdown slash command",
        kind: "custom-command",
      });
    }
  } catch {
    // If loading fails, keep builtin commands.
  }

  cachedCommands = { data: items, timestamp: now };
  return items;
}

export async function fetchSpecialistAgents(repoRoot?: string): Promise<AutocompleteItem[]> {
  const root = repoRoot ?? globalThis.process.cwd();
  const registry = new SpecialistAgentRegistry({ repoRoot: root });
  try {
    const list = await registry.listAgents();
    return list.map((agent) => ({
      id: `agent:${agent.name}`,
      trigger: "file",
      label: agent.name,
      insertText: `@${agent.name} `,
      kind: "agent",
      detail: `[${agent.roleModel ?? "main"}]`,
      description: agent.description,
    }));
  } catch {
    return [];
  }
}

export async function fetchProjectFiles(repoRoot?: string): Promise<AutocompleteItem[]> {
  const now = Date.now();
  if (cachedFiles && now - cachedFiles.timestamp < CACHE_TTL_FILES_MS) {
    return formatFileItems(cachedFiles.data);
  }

  const root = repoRoot ?? globalThis.process.cwd();
  const fileList: string[] = [];
  const glob = new Bun.Glob("**/*");

  for (const relativePath of glob.scanSync({ cwd: root, onlyFiles: false })) {
    const normalized = relativePath.replace(/\\/g, "/");
    const segments = normalized.split("/");
    const isIgnored = segments.some((segment) => IGNORED_SCAN_DIRS.has(segment));
    if (isIgnored) continue;
    fileList.push(normalized);
  }

  cachedFiles = { data: fileList, timestamp: now };
  return formatFileItems(fileList);
}

function formatFileItems(paths: string[]): AutocompleteItem[] {
  return paths.map((path) => {
    const isDir = path.endsWith("/") || !path.includes(".");
    return {
      id: `file:${path}`,
      trigger: "file",
      label: path,
      insertText: `@${path}`,
      kind: isDir ? "dir" : "file",
      description: isDir ? "Direktori proyek" : undefined,
    };
  });
}

export async function fetchAstSymbols(repoRoot?: string): Promise<AutocompleteItem[]> {
  const now = Date.now();
  if (cachedSymbols && now - cachedSymbols.timestamp < CACHE_TTL_SYMBOLS_MS) {
    return cachedSymbols.data;
  }

  const root = repoRoot ?? globalThis.process.cwd();
  const files = cachedFiles ? cachedFiles.data : (await fetchProjectFiles(root)).map((item) => item.label);
  const symbolItems: AutocompleteItem[] = [];

  for (const filePath of files) {
    const language = detectLanguage(filePath);
    if (!language) continue;

    const fullPath = resolve(root, filePath);
    try {
      const source = await readText(fullPath);
      const declarations = extractDeclarations(source, language as SourceLanguage);

      for (const decl of declarations) {
        if (!decl.name || decl.kind === "import") continue;
        symbolItems.push({
          id: `sym:${filePath}:${decl.name}`,
          trigger: "symbol",
          label: decl.name,
          insertText: `#${decl.name}`,
          kind: decl.kind,
          detail: `${filePath}:${decl.endLine}`,
          description: decl.signature[0]?.slice(0, 50) ?? decl.kind,
        });

        for (const member of decl.members ?? []) {
          if (!member.name || member.kind === "import") continue;
          symbolItems.push({
            id: `sym:${filePath}:${decl.name}.${member.name}`,
            trigger: "symbol",
            label: `${decl.name}.${member.name}`,
            insertText: `#${decl.name}.${member.name}`,
            kind: `${decl.kind}.${member.kind}`,
            detail: `${filePath}:${member.endLine}`,
          });
        }
      }
    } catch {
      // Skip files that fail reading or parsing.
    }
  }

  cachedSymbols = { data: symbolItems, timestamp: now };
  return symbolItems;
}

export function invalidateAutocompleteCaches(): void {
  cachedFiles = undefined;
  cachedSymbols = undefined;
  cachedCommands = undefined;
}

export async function queryAutocomplete(
  text: string,
  cursorPos: number,
  repoRoot?: string,
): Promise<{ context: TriggerContext; items: AutocompleteItem[] } | null> {
  const context = detectTriggerContext(text, cursorPos);
  if (!context) return null;

  let sourceItems: AutocompleteItem[] = [];
  if (context.trigger === "command") {
    sourceItems = await fetchSlashCommands(repoRoot);
  } else if (context.trigger === "file") {
    const colonIdx = context.query.indexOf(":");
    const fileQueryPart = colonIdx === -1 ? context.query : context.query.slice(0, colonIdx);
    const lineSuffix = colonIdx === -1 ? "" : context.query.slice(colonIdx);

    const [fileItems, agentItems] = await Promise.all([
      fetchProjectFiles(repoRoot),
      fetchSpecialistAgents(repoRoot),
    ]);
    sourceItems = [...agentItems, ...fileItems];

    const ranked = filterFuzzy(fileQueryPart, sourceItems, (item) => item.label, 20);
    const items = ranked.map(({ item, score }) => {
      if (item.kind === "agent") {
        return {
          ...item,
          score,
        };
      }
      return {
        ...item,
        score,
        insertText: `@${item.label}${lineSuffix}`,
      };
    });
    return { context, items };
  } else if (context.trigger === "symbol") {
    sourceItems = await fetchAstSymbols(repoRoot);
  }

  const ranked = filterFuzzy(context.query, sourceItems, (item) => item.label, 20);
  const items = ranked.map(({ item, score }) => ({ ...item, score }));
  return { context, items };
}

export function AutocompletePopup(props: AutocompletePopupProps) {
  const {
    items,
    selectedIndex,
    trigger,
    theme = getTheme("tokyonight"),
    maxVisible = 6,
  } = props;

  if (items.length === 0) {
    return null;
  }

  const clampedSelected = Math.max(0, Math.min(items.length - 1, selectedIndex));
  const halfWindow = Math.floor(maxVisible / 2);
  let startIndex = Math.max(0, clampedSelected - halfWindow);
  if (startIndex + maxVisible > items.length) {
    startIndex = Math.max(0, items.length - maxVisible);
  }
  const visibleItems = items.slice(startIndex, startIndex + maxVisible);

  let triggerLabel = "PENCARIAN CEPAT";
  let triggerColor = theme.accent;
  if (trigger === "command") {
    triggerLabel = "SLASH COMMANDS (/)";
    triggerColor = theme.modes.plan.primary;
  } else if (trigger === "file") {
    triggerLabel = "FILE & SPECIALIST AGENTS (@)";
    triggerColor = theme.modes.build.primary;
  } else if (trigger === "symbol") {
    triggerLabel = "SIMBOL AST (#)";
    triggerColor = theme.modes.ultrawork.primary;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={triggerColor}
      paddingX={1}
      marginBottom={0}
    >
      <Box justifyContent="space-between">
        <Text bold color={triggerColor}>
          [{triggerLabel}]
        </Text>
        <Text dimColor>
          {clampedSelected + 1} dari {items.length} opsi
        </Text>
      </Box>

      <Box flexDirection="column" marginY={0}>
        {visibleItems.map((item, index) => {
          const actualIndex = startIndex + index;
          const isSelected = actualIndex === clampedSelected;

          return (
            <Box key={item.id} justifyContent="space-between">
              <Box>
                <Text color={isSelected ? triggerColor : undefined} bold={isSelected}>
                  {isSelected ? "> " : "  "}
                  {item.label}
                </Text>
                {item.kind ? (
                  <Text color={theme.muted}> [{item.kind}]</Text>
                ) : null}
                {item.detail ? (
                  <Text dimColor> {item.detail}</Text>
                ) : null}
              </Box>
              {item.description ? (
                <Text dimColor>
                  {item.description.length > 45
                    ? `${item.description.slice(0, 42)}...`
                    : item.description}
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>

      <Box marginTop={0}>
        <Text dimColor>
          Navigasi: Up/Down | Sisipkan: Tab/Enter | Tutup: Esc
        </Text>
      </Box>
    </Box>
  );
}
