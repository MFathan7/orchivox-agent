import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { z } from "zod";

import { computeLineHash, formatLine, splitLines } from "../tools/hashline-edit";
import type { AgentTool, ToolRegistry } from "../tools/registry";
import type { LSPClient, LSPWorkspaceSymbol } from "./lsp-client";

export interface DependencyGraphNode {
  filePath: string;
  imports: string[];
  importedBy: string[];
  centralityScore: number;
  symbols: string[];
}

export interface DependencyGraph {
  nodes: Map<string, DependencyGraphNode>;
  cycles: string[][];
  hubFiles: DependencyGraphNode[];
  totalFiles: number;
  totalEdges: number;
}

export interface WorkspaceSymbolItem {
  name: string;
  kind: string;
  file: string;
  line: number;
  column: number;
  formattedLine: string;
  containerName?: string;
}

export interface HoverTypeResult {
  symbolName: string;
  filePath: string;
  line: number;
  column: number;
  signature: string;
  documentation?: string;
  source: "lsp" | "ast";
}

export interface SymbolImpactUsage {
  line: number;
  formattedLine: string;
  category: "import" | "call" | "type" | "export" | "reference";
}

export interface FileImpact {
  filePath: string;
  usages: SymbolImpactUsage[];
}

export interface SymbolImpactReport {
  symbolName: string;
  definingFile?: string;
  definingLine?: number;
  kind?: string;
  riskLevel: "low" | "medium" | "high" | "isolated";
  totalFiles: number;
  totalUsages: number;
  consumers: FileImpact[];
  summary: string;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".agent",
  "dist",
  "build",
  ".next",
  "coverage",
  "out",
  ".turbo",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

export async function collectSourceFiles(dir: string, repoRoot: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          await walk(join(currentDir, entry.name));
        }
      } else if (entry.isFile()) {
        const ext = getExtension(entry.name);
        if (SOURCE_EXTENSIONS.has(ext)) {
          const fullPath = join(currentDir, entry.name);
          const relPath = relative(repoRoot, fullPath);
          files.push(relPath);
        }
      }
    }
  }

  await walk(dir);
  return files.sort();
}

function getExtension(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index !== -1 ? filename.slice(index).toLowerCase() : "";
}

function resolveImportPath(
  sourceRelFile: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  let candidateBase: string;

  if (specifier.startsWith(".")) {
    const sourceDir = dirname(sourceRelFile);
    candidateBase = normalize(join(sourceDir, specifier));
  } else if (specifier.startsWith("@/")) {
    candidateBase = normalize(join("src", specifier.slice(2)));
  } else if (specifier.startsWith("src/")) {
    candidateBase = normalize(specifier);
  } else {
    // External package (e.g. "react", "zod", "bun:test")
    return null;
  }

  if (knownFiles.has(candidateBase)) {
    return candidateBase;
  }

  const extensionsToTry = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    "/index.ts",
    "/index.tsx",
    "/index.js",
    "/index.jsx",
  ];

  for (const ext of extensionsToTry) {
    const candidate = candidateBase + ext;
    if (knownFiles.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const lines = splitLines(source);

  // Match import ... from '...' or export ... from '...'
  const importExportRegex = /(?:import|export)\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]/g;
  // Match require('...')
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // Match dynamic import('...')
  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) continue;

    let match: RegExpExecArray | null;
    importExportRegex.lastIndex = 0;
    while ((match = importExportRegex.exec(line)) !== null) {
      if (match[1]) specifiers.push(match[1]);
    }

    requireRegex.lastIndex = 0;
    while ((match = requireRegex.exec(line)) !== null) {
      if (match[1]) specifiers.push(match[1]);
    }

    dynamicImportRegex.lastIndex = 0;
    while ((match = dynamicImportRegex.exec(line)) !== null) {
      if (match[1]) specifiers.push(match[1]);
    }
  }

  return Array.from(new Set(specifiers));
}

export function extractExportedSymbols(source: string): string[] {
  const symbols: string[] = [];
  const exportRegex = /(?:^|\n)\s*export\s+(?:default\s+)?(?:declare\s+)?(class|interface|type|enum|function|const|let|var)\s+([A-Za-z0-9_$]+)/g;

  let match: RegExpExecArray | null;
  while ((match = exportRegex.exec(source)) !== null) {
    if (match[2]) symbols.push(match[2]);
  }

  return Array.from(new Set(symbols));
}

export async function analyzeRepoGraph(
  repoRoot: string,
  options?: { maxFiles?: number },
): Promise<DependencyGraph> {
  const allFiles = await collectSourceFiles(repoRoot, repoRoot);
  const selectedFiles = options?.maxFiles ? allFiles.slice(0, options.maxFiles) : allFiles;
  const knownFiles = new Set(selectedFiles);

  const nodes = new Map<string, DependencyGraphNode>();

  for (const file of selectedFiles) {
    nodes.set(file, {
      filePath: file,
      imports: [],
      importedBy: [],
      centralityScore: 0,
      symbols: [],
    });
  }

  let totalEdges = 0;

  for (const file of selectedFiles) {
    const fullPath = resolve(repoRoot, file);
    let content = "";
    try {
      content = await readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    const node = nodes.get(file)!;
    node.symbols = extractExportedSymbols(content);

    const specifiers = extractImportSpecifiers(content);
    const resolvedImports = new Set<string>();

    for (const specifier of specifiers) {
      const resolved = resolveImportPath(file, specifier, knownFiles);
      if (resolved && resolved !== file) {
        resolvedImports.add(resolved);
      }
    }

    node.imports = Array.from(resolvedImports).sort();
    totalEdges += node.imports.length;

    for (const imp of node.imports) {
      const targetNode = nodes.get(imp);
      if (targetNode && !targetNode.importedBy.includes(file)) {
        targetNode.importedBy.push(file);
      }
    }
  }

  for (const node of nodes.values()) {
    node.importedBy.sort();
  }

  computePageRank(nodes);

  const cycles = findCycles(nodes);

  const hubFiles = Array.from(nodes.values()).sort(
    (a, b) => b.centralityScore - a.centralityScore,
  );

  return {
    nodes,
    cycles,
    hubFiles,
    totalFiles: nodes.size,
    totalEdges,
  };
}

function computePageRank(
  nodes: Map<string, DependencyGraphNode>,
  iterations = 30,
  damping = 0.85,
): void {
  const n = nodes.size;
  if (n === 0) return;

  const nodeKeys = Array.from(nodes.keys());
  let totalInDegrees = 0;
  for (const node of nodes.values()) {
    totalInDegrees += node.importedBy.length;
  }

  const restartProb = new Map<string, number>();
  for (const key of nodeKeys) {
    const inDeg = nodes.get(key)!.importedBy.length;
    restartProb.set(key, totalInDegrees > 0 ? (inDeg + 1) / (totalInDegrees + n) : 1 / n);
  }

  let scores = new Map<string, number>();
  for (const key of nodeKeys) {
    scores.set(key, restartProb.get(key) ?? 1 / n);
  }

  for (let it = 0; it < iterations; it++) {
    const nextScores = new Map<string, number>();

    let sinkWeight = 0;
    for (const key of nodeKeys) {
      const node = nodes.get(key)!;
      if (node.imports.length === 0) {
        sinkWeight += scores.get(key) ?? 0;
      }
    }

    for (const key of nodeKeys) {
      const prior = restartProb.get(key) ?? 1 / n;
      const baseRank = (1 - damping) * prior + damping * sinkWeight * prior;

      let incomingRank = 0;
      const node = nodes.get(key)!;

      for (const parentKey of node.importedBy) {
        const parent = nodes.get(parentKey);
        if (parent && parent.imports.length > 0) {
          const parentScore = scores.get(parentKey) ?? 0;
          incomingRank += parentScore / parent.imports.length;
        }
      }

      nextScores.set(key, baseRank + damping * incomingRank);
    }

    scores = nextScores;
  }

  for (const [key, score] of scores.entries()) {
    const node = nodes.get(key);
    if (node) {
      const inDegreeNorm = totalInDegrees > 0 ? node.importedBy.length / totalInDegrees : 0;
      node.centralityScore = 0.5 * score + 0.5 * inDegreeNorm;
    }
  }
}

function findCycles(nodes: Map<string, DependencyGraphNode>): string[][] {
  const visited = new Map<string, "unvisited" | "visiting" | "visited">();
  for (const key of nodes.keys()) {
    visited.set(key, "unvisited");
  }

  const cycles: string[][] = [];
  const cycleSignatures = new Set<string>();

  function dfs(current: string, path: string[]): void {
    visited.set(current, "visiting");
    path.push(current);

    const node = nodes.get(current);
    if (node) {
      for (const neighbor of node.imports) {
        const status = visited.get(neighbor);
        if (status === "visiting") {
          const cycleStart = path.indexOf(neighbor);
          if (cycleStart !== -1) {
            const cycle = path.slice(cycleStart);
            cycle.push(neighbor);
            const signature = normalizeCycle(cycle);
            if (!cycleSignatures.has(signature)) {
              cycleSignatures.add(signature);
              cycles.push(cycle);
            }
          }
        } else if (status === "unvisited") {
          dfs(neighbor, path);
        }
      }
    }

    path.pop();
    visited.set(current, "visited");
  }

  for (const key of nodes.keys()) {
    if (visited.get(key) === "unvisited") {
      dfs(key, []);
    }
  }

  return cycles;
}

function normalizeCycle(cycle: string[]): string {
  const elements = cycle.slice(0, cycle.length - 1);
  if (elements.length === 0) return cycle.join(" -> ");

  let minIndex = 0;
  for (let i = 1; i < elements.length; i++) {
    if (elements[i] < elements[minIndex]) {
      minIndex = i;
    }
  }

  const rotated = [...elements.slice(minIndex), ...elements.slice(0, minIndex)];
  return rotated.join(" -> ");
}

export async function scanWorkspaceSymbols(
  repoRoot: string,
  query: string,
  options?: { kind?: string; maxResults?: number },
): Promise<WorkspaceSymbolItem[]> {
  const allFiles = await collectSourceFiles(repoRoot, repoRoot);
  const results: WorkspaceSymbolItem[] = [];
  const normalizedQuery = query.toLowerCase();
  const maxResults = options?.maxResults ?? 25;
  const targetKind = options?.kind && options.kind !== "all" ? options.kind.toLowerCase() : undefined;

  const declarationRegex = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(class|interface|type|enum|function|const|let|var)\s+([A-Za-z0-9_$]+)/g;

  for (const relFile of allFiles) {
    if (results.length >= maxResults) break;

    const fullPath = resolve(repoRoot, relFile);
    let content = "";
    try {
      content = await readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    const lines = splitLines(content);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      if (results.length >= maxResults) break;
      const lineText = lines[lineIndex];

      declarationRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = declarationRegex.exec(lineText)) !== null) {
        const kind = match[1];
        const name = match[2];

        if (targetKind && kind !== targetKind) {
          continue;
        }

        if (name.toLowerCase().includes(normalizedQuery)) {
          const colIndex = lineText.indexOf(name) + 1;
          const lineNumber = lineIndex + 1;
          results.push({
            name,
            kind,
            file: relFile,
            line: lineNumber,
            column: colIndex > 0 ? colIndex : 1,
            formattedLine: formatLine(lineNumber, lineText),
          });
          break;
        }
      }
    }
  }

  return results;
}

export async function getHoverTypeInfo(
  repoRoot: string,
  filePath: string,
  line: number,
  column: number,
  lsp?: LSPClient,
): Promise<HoverTypeResult> {
  const fullPath = isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);
  const relPath = relative(repoRoot, fullPath);

  if (lsp && lsp.isReady()) {
    try {
      const hoverText = await lsp.hover(fullPath, line, column);
      if (hoverText && hoverText.trim().length > 0) {
        return {
          symbolName: `symbol at ${relPath}:${line}:${column}`,
          filePath: relPath,
          line,
          column,
          signature: hoverText,
          source: "lsp",
        };
      }
    } catch {
      // Fallback to AST extraction
    }
  }

  let content = "";
  try {
    content = await readFile(fullPath, "utf8");
  } catch {
    throw new Error(`file not found: ${filePath}`);
  }

  const lines = splitLines(content);
  if (line < 1 || line > lines.length) {
    throw new Error(`line ${line} out of bounds for ${filePath} (1-${lines.length})`);
  }

  const targetLine = lines[line - 1];

  let symbolName = "";
  const tokenRegex = /[A-Za-z0-9_$]+/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(targetLine)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (column - 1 >= start && column - 1 <= end) {
      symbolName = match[0];
      break;
    }
  }

  if (!symbolName) {
    tokenRegex.lastIndex = 0;
    const firstMatch = tokenRegex.exec(targetLine);
    symbolName = firstMatch ? firstMatch[0] : targetLine.trim();
  }

  let docLines: string[] = [];
  let checkIndex = line - 2;

  while (checkIndex >= 0 && lines[checkIndex].trim().length === 0) {
    checkIndex -= 1;
  }

  if (checkIndex >= 0 && lines[checkIndex].trim().endsWith("*/")) {
    const commentCollected: string[] = [];
    while (checkIndex >= 0) {
      const currentComment = lines[checkIndex];
      commentCollected.unshift(currentComment.trim());
      if (currentComment.trim().startsWith("/**") || currentComment.trim().startsWith("/*")) {
        break;
      }
      checkIndex -= 1;
    }
    docLines = commentCollected;
  }

  const signatureLines: string[] = [targetLine.trim()];
  let forwardIndex = line;
  while (
    forwardIndex < lines.length &&
    forwardIndex < line + 4 &&
    !targetLine.includes("{") &&
    !targetLine.includes(";")
  ) {
    const nextText = lines[forwardIndex].trim();
    if (nextText.length > 0) {
      signatureLines.push(nextText);
      if (nextText.includes("{") || nextText.includes(";")) break;
    }
    forwardIndex += 1;
  }

  const signature = signatureLines.join(" ");
  const documentation =
    docLines.length > 0
      ? docLines
          .map((l) => l.replace(/^\/\*\*?|\*\/$|^\s*\*\s?/g, "").trim())
          .filter(Boolean)
          .join("\n")
      : undefined;

  return {
    symbolName,
    filePath: relPath,
    line,
    column,
    signature,
    documentation,
    source: "ast",
  };
}

export async function analyzeSymbolImpact(
  repoRoot: string,
  symbolName: string,
  options?: { filePath?: string; maxConsumers?: number },
): Promise<SymbolImpactReport> {
  const maxConsumers = options?.maxConsumers ?? 50;
  const allFiles = await collectSourceFiles(repoRoot, repoRoot);

  let definingFile = options?.filePath ? normalize(options.filePath) : undefined;
  let definingLine: number | undefined;
  let detectedKind: string | undefined;

  const defRegex = new RegExp(
    `(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(class|interface|type|enum|function|const|let|var)\\s+${symbolName}\\b`,
  );

  if (definingFile) {
    const fullPath = resolve(repoRoot, definingFile);
    try {
      const content = await readFile(fullPath, "utf8");
      const lines = splitLines(content);
      for (let i = 0; i < lines.length; i++) {
        const match = defRegex.exec(lines[i]);
        if (match) {
          definingLine = i + 1;
          detectedKind = match[1];
          break;
        }
      }
    } catch {
      // definingFile couldn't be opened directly
    }
  } else {
    for (const relFile of allFiles) {
      const fullPath = resolve(repoRoot, relFile);
      let content = "";
      try {
        content = await readFile(fullPath, "utf8");
      } catch {
        continue;
      }

      const lines = splitLines(content);
      for (let i = 0; i < lines.length; i++) {
        const match = defRegex.exec(lines[i]);
        if (match) {
          definingFile = relFile;
          definingLine = i + 1;
          detectedKind = match[1];
          break;
        }
      }
      if (definingFile) break;
    }
  }

  const wordRegex = new RegExp(`\\b${symbolName}\\b`);
  const consumers: FileImpact[] = [];
  let totalUsages = 0;

  for (const relFile of allFiles) {
    if (consumers.length >= maxConsumers) break;
    if (definingFile && relFile === definingFile && !options?.filePath) {
      continue;
    }

    const fullPath = resolve(repoRoot, relFile);
    let content = "";
    try {
      content = await readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    if (!wordRegex.test(content)) continue;

    const lines = splitLines(content);
    const fileUsages: SymbolImpactUsage[] = [];

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (wordRegex.test(lineText)) {
        let category: SymbolImpactUsage["category"] = "reference";
        const trimmed = lineText.trim();

        if (trimmed.startsWith("import ") || trimmed.includes("require(")) {
          category = "import";
        } else if (trimmed.startsWith("export ")) {
          category = "export";
        } else if (
          new RegExp(`new\\s+${symbolName}\\b|\\b${symbolName}\\s*\\(|\\b${symbolName}\\.`).test(
            trimmed,
          )
        ) {
          category = "call";
        } else if (
          new RegExp(`:\\s*${symbolName}\\b|<${symbolName}>|implements\\s+${symbolName}\\b|as\\s+${symbolName}\\b`).test(
            trimmed,
          )
        ) {
          category = "type";
        }

        const lineNumber = i + 1;
        fileUsages.push({
          line: lineNumber,
          formattedLine: formatLine(lineNumber, lineText),
          category,
        });
        totalUsages += 1;
      }
    }

    if (fileUsages.length > 0) {
      consumers.push({
        filePath: relFile,
        usages: fileUsages,
      });
    }
  }

  const totalFiles = consumers.length;
  let riskLevel: SymbolImpactReport["riskLevel"] = "isolated";

  if (totalFiles === 0) {
    riskLevel = "isolated";
  } else if (totalFiles === 1) {
    riskLevel = "low";
  } else if (totalFiles <= 4) {
    riskLevel = "medium";
  } else {
    riskLevel = "high";
  }

  const summary = [
    `Symbol: ${symbolName}${detectedKind ? ` (${detectedKind})` : ""}`,
    definingFile ? `Defined at: ${definingFile}:${definingLine ?? 1}` : "Definition file: unknown",
    `Risk level: ${riskLevel.toUpperCase()}`,
    `Impact: ${totalFiles} consumer file(s) with ${totalUsages} total reference site(s).`,
  ].join("\n");

  return {
    symbolName,
    definingFile,
    definingLine,
    kind: detectedKind,
    riskLevel,
    totalFiles,
    totalUsages,
    consumers,
    summary,
  };
}

export function createRepoArchitectureMapTool(options?: {
  repoRoot?: string;
}): AgentTool {
  const repoRoot = options?.repoRoot ?? globalThis.process.cwd();

  return {
    name: "repo_architecture_map",
    description:
      "Get a high-level architecture map of the codebase showing top hub files ranked by centrality, module structure, circular dependencies, and key symbols.",
    parameters: z.object({
      maxHubs: z.number().int().positive().default(20).describe("Maximum number of hub files to display."),
      includeCycles: z.boolean().default(true).describe("Whether to include circular dependency analysis."),
      includeSymbols: z.boolean().default(true).describe("Whether to include key exported symbols."),
    }),
    readOnly: true,
    execute: async (args) => {
      const input = args as { maxHubs: number; includeCycles: boolean; includeSymbols: boolean };
      const graph = await analyzeRepoGraph(repoRoot);

      const topHubs = graph.hubFiles.slice(0, input.maxHubs);

      const hubLines: string[] = topHubs.map((hub, idx) => {
        const symbolText =
          input.includeSymbols && hub.symbols.length > 0
            ? `\n     Symbols: ${hub.symbols.slice(0, 6).join(", ")}${hub.symbols.length > 6 ? ` (+${hub.symbols.length - 6} more)` : ""}`
            : "";
        return `  ${idx + 1}. ${hub.filePath} (score: ${hub.centralityScore.toFixed(4)}, in: ${hub.importedBy.length}, out: ${hub.imports.length})${symbolText}`;
      });

      const modules = new Map<string, number>();
      for (const node of graph.nodes.values()) {
        const parts = node.filePath.split("/");
        const modKey = parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
        modules.set(modKey, (modules.get(modKey) ?? 0) + 1);
      }

      const moduleLines = Array.from(modules.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([mod, count]) => `  - ${mod} (${count} files)`);

      let cyclesSection = "None detected (DAG verified).";
      if (input.includeCycles && graph.cycles.length > 0) {
        cyclesSection = `Found ${graph.cycles.length} circular dependency chain(s):\n` +
          graph.cycles.map((c, i) => `  ${i + 1}. ${c.join(" -> ")}`).join("\n");
      }

      return [
        "[PROJECT ARCHITECTURE MAP]",
        `Workspace: ${repoRoot}`,
        `Total Source Files: ${graph.totalFiles}`,
        `Total Internal Dependencies: ${graph.totalEdges}`,
        "",
        `--- Top Hub Files (${topHubs.length}) ---`,
        hubLines.join("\n"),
        "",
        `--- Module Breakdown ---`,
        moduleLines.join("\n"),
        "",
        `--- Circular Dependencies ---`,
        cyclesSection,
      ].join("\n");
    },
  };
}

export function createLspWorkspaceSymbolsTool(options?: {
  lsp?: LSPClient;
  repoRoot?: string;
}): AgentTool {
  const repoRoot = options?.repoRoot ?? globalThis.process.cwd();
  const lsp = options?.lsp;

  return {
    name: "lsp_workspace_symbols",
    description:
      "Search for symbols (class, function, interface, type, variable, constant, enum) across the workspace by keyword. Returns matching declarations with their file location and hashline-formatted code snippet.",
    parameters: z.object({
      query: z.string().min(1).describe("Search query for symbol name."),
      kind: z
        .enum(["all", "class", "function", "interface", "type", "variable", "constant", "enum"])
        .default("all")
        .describe("Filter by symbol kind."),
      maxResults: z.number().int().positive().default(25).describe("Maximum symbols to return."),
    }),
    readOnly: true,
    execute: async (args) => {
      const input = args as { query: string; kind?: string; maxResults?: number };
      const maxResults = input.maxResults ?? 25;

      if (lsp && lsp.isReady()) {
        try {
          const lspSymbols = await lsp.workspaceSymbols(input.query);
          if (lspSymbols.length > 0) {
            const filtered =
              input.kind && input.kind !== "all"
                ? lspSymbols.filter((s) => s.kind.toLowerCase() === input.kind?.toLowerCase())
                : lspSymbols;

            const selected = filtered.slice(0, maxResults);
            const items: string[] = [];

            for (const sym of selected) {
              const relFile = relative(repoRoot, sym.file);
              let lineSnippet = "";
              try {
                const content = await readFile(sym.file, "utf8");
                const lines = splitLines(content);
                if (sym.line >= 1 && sym.line <= lines.length) {
                  lineSnippet = `\n    ${formatLine(sym.line, lines[sym.line - 1])}`;
                }
              } catch {
                // Keep without line snippet
              }
              items.push(`- [${sym.kind}] ${sym.name} in ${relFile}:${sym.line}${lineSnippet}`);
            }

            if (items.length > 0) {
              return [
                `Workspace symbols matching "${input.query}" (via LSP, ${items.length} returned):`,
                ...items,
              ].join("\n");
            }
          }
        } catch {
          // Fallback to static workspace scanner
        }
      }

      const results = await scanWorkspaceSymbols(repoRoot, input.query, input);
      if (results.length === 0) {
        return `No workspace symbols found matching "${input.query}".`;
      }

      const rows = results.map(
        (s) => `- [${s.kind}] ${s.name} in ${s.file}:${s.line}\n    ${s.formattedLine}`,
      );

      return [`Workspace symbols matching "${input.query}" (${results.length} found):`, ...rows].join(
        "\n",
      );
    },
  };
}

export function createLspHoverTypeTool(options?: {
  lsp?: LSPClient;
  repoRoot?: string;
}): AgentTool {
  const repoRoot = options?.repoRoot ?? globalThis.process.cwd();
  const lsp = options?.lsp;

  return {
    name: "lsp_hover_type",
    description:
      "Retrieve detailed type information, signatures, and JSDoc documentation for a symbol at a specific line and column using LSP textDocument/hover, with AST fallback.",
    parameters: z.object({
      filePath: z.string().min(1).describe("Relative or absolute file path."),
      line: z.number().int().positive().describe("1-based line number."),
      column: z.number().int().positive().describe("1-based column position."),
    }),
    readOnly: true,
    execute: async (args) => {
      const input = args as { filePath: string; line: number; column: number };
      const info = await getHoverTypeInfo(repoRoot, input.filePath, input.line, input.column, lsp);

      const docSection = info.documentation
        ? `\n**Documentation:**\n${info.documentation}`
        : "";

      return [
        `[HOVER TYPE INFORMATION: ${info.source.toUpperCase()}]`,
        `Location: ${info.filePath}:${info.line}:${info.column}`,
        `Symbol: ${info.symbolName}`,
        "",
        "```typescript",
        info.signature,
        "```",
        docSection,
      ].filter(Boolean).join("\n");
    },
  };
}

export function createSymbolImpactAnalysisTool(options?: {
  lsp?: LSPClient;
  repoRoot?: string;
}): AgentTool {
  const repoRoot = options?.repoRoot ?? globalThis.process.cwd();

  return {
    name: "symbol_impact_analysis",
    description:
      "Analyze which files and lines across the repository import or call a symbol before breaking changes or refactoring. Provides risk level and usage breakdown.",
    parameters: z.object({
      symbolName: z
        .string()
        .min(1)
        .describe("Name of the symbol (function, class, interface, type) to analyze."),
      filePath: z.string().optional().describe("Optional file path where the symbol is defined."),
      maxConsumers: z
        .number()
        .int()
        .positive()
        .default(50)
        .describe("Maximum consumer files to list."),
    }),
    readOnly: true,
    execute: async (args) => {
      const input = args as { symbolName: string; filePath?: string; maxConsumers?: number };
      const report = await analyzeSymbolImpact(repoRoot, input.symbolName, input);

      if (report.totalFiles === 0 && !report.definingFile) {
        return `Symbol "${input.symbolName}" was not found in workspace declarations or source files.`;
      }

      const consumerLines: string[] = [];
      for (let i = 0; i < report.consumers.length; i++) {
        const consumer = report.consumers[i];
        const siteText = consumer.usages.length === 1 ? "1 usage" : `${consumer.usages.length} usages`;
        consumerLines.push(`  ${i + 1}. ${consumer.filePath} (${siteText}):`);
        for (const u of consumer.usages.slice(0, 5)) {
          consumerLines.push(`     [${u.category}] ${u.formattedLine}`);
        }
        if (consumer.usages.length > 5) {
          consumerLines.push(`     ... and ${consumer.usages.length - 5} more usage(s) in this file`);
        }
      }

      const recommendations: string[] = [];
      if (report.riskLevel === "high") {
        recommendations.push(
          "- High architectural impact: this symbol is imported across multiple core modules.",
          "- Verify all dependent files compile with `bun run typecheck` after refactoring.",
          "- Run full test suites with `bun test` to ensure behavior integrity.",
        );
      } else if (report.riskLevel === "medium") {
        recommendations.push(
          "- Moderate impact: update consuming call sites before renaming or changing signature.",
          "- Run targeted test suites for impacted modules.",
        );
      } else if (report.riskLevel === "low") {
        recommendations.push(
          "- Low impact: only 1 consumer file is affected.",
        );
      } else {
        recommendations.push(
          "- Isolated symbol: no external consumers found in the workspace.",
        );
      }

      return [
        `[SYMBOL IMPACT REPORT: ${report.symbolName}]`,
        report.summary,
        "",
        `--- Dependent Files (${report.consumers.length}) ---`,
        consumerLines.length > 0 ? consumerLines.join("\n") : "  None (symbol is isolated).",
        "",
        "--- Refactoring Recommendations ---",
        recommendations.join("\n"),
      ].join("\n");
    },
  };
}

export function registerCodeIntelTools(
  registry: ToolRegistry,
  options?: { lsp?: LSPClient; repoRoot?: string },
): void {
  registry.register(createRepoArchitectureMapTool(options));
  registry.register(createLspWorkspaceSymbolsTool(options));
  registry.register(createLspHoverTypeTool(options));
  registry.register(createSymbolImpactAnalysisTool(options));
}
