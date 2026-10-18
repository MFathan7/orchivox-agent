import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ToolRegistry } from "../src/tools/registry";
import {
  analyzeRepoGraph,
  analyzeSymbolImpact,
  createLspHoverTypeTool,
  createLspWorkspaceSymbolsTool,
  createRepoArchitectureMapTool,
  createSymbolImpactAnalysisTool,
  extractExportedSymbols,
  extractImportSpecifiers,
  getHoverTypeInfo,
  registerCodeIntelTools,
  scanWorkspaceSymbols,
} from "../src/ide/code-intel";
import { LSPClient } from "../src/ide/lsp-client";

const TEST_DIR = resolve(process.cwd(), ".agent/test-plan19");

async function setupTestWorkspace(): Promise<void> {
  if (existsSync(TEST_DIR)) {
    await rm(TEST_DIR, { recursive: true, force: true });
  }
  await mkdir(resolve(TEST_DIR, "core"), { recursive: true });
  await mkdir(resolve(TEST_DIR, "services"), { recursive: true });
  await mkdir(resolve(TEST_DIR, "cycles"), { recursive: true });

  // Core base utility (foundation hub)
  await writeFile(
    resolve(TEST_DIR, "core/types.ts"),
    [
      "/** Configuration options for the engine */",
      "export interface EngineConfig {",
      "  readonly id: string;",
      "  readonly timeoutMs: number;",
      "}",
      "",
      "export type EngineStatus = 'idle' | 'running' | 'stopped';",
    ].join("\n"),
  );

  // Core logger that imports types
  await writeFile(
    resolve(TEST_DIR, "core/logger.ts"),
    [
      "import type { EngineConfig } from './types';",
      "",
      "/** Global logger utility */",
      "export class Logger {",
      "  constructor(private config: EngineConfig) {}",
      "  info(msg: string): void {",
      "    console.log(msg);",
      "  }",
      "}",
    ].join("\n"),
  );

  // Service A that imports types and logger
  await writeFile(
    resolve(TEST_DIR, "services/auth-service.ts"),
    [
      "import { EngineConfig } from '../core/types';",
      "import { Logger } from '../core/logger';",
      "",
      "export class AuthService {",
      "  private logger: Logger;",
      "  constructor(config: EngineConfig) {",
      "    this.logger = new Logger(config);",
      "  }",
      "}",
    ].join("\n"),
  );

  // Service B that also imports types and logger
  await writeFile(
    resolve(TEST_DIR, "services/data-service.ts"),
    [
      "import { EngineConfig, EngineStatus } from '../core/types';",
      "import { Logger } from '../core/logger';",
      "",
      "export class DataService {",
      "  private logger: Logger;",
      "  public status: EngineStatus = 'idle';",
      "  constructor(config: EngineConfig) {",
      "    this.logger = new Logger(config);",
      "  }",
      "}",
    ].join("\n"),
  );

  // Circular dependency pair: cycleA <-> cycleB
  await writeFile(
    resolve(TEST_DIR, "cycles/module-a.ts"),
    [
      "import { helperB } from './module-b';",
      "export function helperA(): string {",
      "  return 'A' + helperB();",
      "}",
    ].join("\n"),
  );

  await writeFile(
    resolve(TEST_DIR, "cycles/module-b.ts"),
    [
      "import { helperA } from './module-a';",
      "export function helperB(): string {",
      "  return 'B';",
      "}",
    ].join("\n"),
  );
}

describe("Dependency Graph & Centrality Ranker", () => {
  it("extracts import specifiers and exported symbols accurately", () => {
    const code = [
      "import { foo, bar } from './foo';",
      "import type { Baz } from '../baz';",
      "const local = require('./local');",
      "export class MasterAgent {}",
      "export interface AgentOptions {}",
      "export function runTask(): void {}",
      "export const VERSION = '1.0';",
    ].join("\n");

    const specifiers = extractImportSpecifiers(code);
    expect(specifiers).toContain("./foo");
    expect(specifiers).toContain("../baz");
    expect(specifiers).toContain("./local");

    const symbols = extractExportedSymbols(code);
    expect(symbols).toContain("MasterAgent");
    expect(symbols).toContain("AgentOptions");
    expect(symbols).toContain("runTask");
    expect(symbols).toContain("VERSION");
  });

  it("analyzes repo graph, resolves dependencies, and ranks hubs by centrality", async () => {
    await setupTestWorkspace();
    const graph = await analyzeRepoGraph(TEST_DIR);

    expect(graph.totalFiles).toBe(6);
    expect(graph.totalEdges).toBeGreaterThanOrEqual(6);

    // Types & Logger should have high in-degrees
    const typesNode = graph.nodes.get("core/types.ts");
    expect(typesNode).toBeDefined();
    expect(typesNode?.importedBy.length).toBeGreaterThanOrEqual(3);

    const loggerNode = graph.nodes.get("core/logger.ts");
    expect(loggerNode).toBeDefined();
    expect(loggerNode?.importedBy.length).toBeGreaterThanOrEqual(2);

    // Hub files are sorted by centrality descending
    expect(graph.hubFiles.length).toBe(6);
    // Highest centrality should be the heavily imported core files
    const topHubPaths = graph.hubFiles.slice(0, 2).map((h) => h.filePath);
    expect(topHubPaths).toContain("core/types.ts");
  });

  it("detects circular dependencies in the codebase", async () => {
    await setupTestWorkspace();
    const graph = await analyzeRepoGraph(TEST_DIR);

    expect(graph.cycles.length).toBeGreaterThanOrEqual(1);
    const cycleStr = graph.cycles.map((c) => c.join(" -> ")).join("\n");
    expect(cycleStr).toContain("cycles/module-a.ts");
    expect(cycleStr).toContain("cycles/module-b.ts");
  });
});

describe("Deep IDE Code Intelligence Tools", () => {
  it("generates comprehensive repo_architecture_map", async () => {
    await setupTestWorkspace();
    const tool = createRepoArchitectureMapTool({ repoRoot: TEST_DIR });

    const result = await tool.execute({
      maxHubs: 5,
      includeCycles: true,
      includeSymbols: true,
    });

    expect(result).toContain("[PROJECT ARCHITECTURE MAP]");
    expect(result).toContain("Total Source Files: 6");
    expect(result).toContain("--- Top Hub Files");
    expect(result).toContain("core/types.ts");
    expect(result).toContain("--- Module Breakdown ---");
    expect(result).toContain("--- Circular Dependencies ---");
    expect(result).toContain("cycles/module-a.ts -> cycles/module-b.ts");
  });

  it("scans workspace symbols with lsp_workspace_symbols and formats hashline snippets", async () => {
    await setupTestWorkspace();
    const tool = createLspWorkspaceSymbolsTool({ repoRoot: TEST_DIR });

    const result = await tool.execute({
      query: "Logger",
      kind: "all",
      maxResults: 10,
    });

    expect(result).toContain('Workspace symbols matching "Logger"');
    expect(result).toContain("[class] Logger in core/logger.ts");
    // Verify hashline format: line:hash| content
    expect(result).toMatch(/\d+:[0-9a-f]{3}\| export class Logger/);
  });

  it("filters workspace symbols by kind", async () => {
    await setupTestWorkspace();
    const tool = createLspWorkspaceSymbolsTool({ repoRoot: TEST_DIR });

    const result = await tool.execute({
      query: "Engine",
      kind: "interface",
      maxResults: 10,
    });

    expect(result).toContain("[interface] EngineConfig in core/types.ts");
    expect(result).not.toContain("[type] EngineStatus");
  });

  it("extracts type and documentation with lsp_hover_type fallback", async () => {
    await setupTestWorkspace();
    const tool = createLspHoverTypeTool({ repoRoot: TEST_DIR });

    const result = await tool.execute({
      filePath: "core/logger.ts",
      line: 4,
      column: 15,
    });

    expect(result).toContain("[HOVER TYPE INFORMATION: AST]");
    expect(result).toContain("Location: core/logger.ts:4:15");
    expect(result).toContain("export class Logger {");
    expect(result).toContain("Global logger utility");
  });

  it("performs symbol_impact_analysis and categorizes usages and risk levels", async () => {
    await setupTestWorkspace();
    const tool = createSymbolImpactAnalysisTool({ repoRoot: TEST_DIR });

    const report = await tool.execute({
      symbolName: "Logger",
      filePath: "core/logger.ts",
    });

    expect(report).toContain("[SYMBOL IMPACT REPORT: Logger]");
    expect(report).toContain("Defined at: core/logger.ts:4");
    expect(report).toContain("services/auth-service.ts");
    expect(report).toContain("services/data-service.ts");
    expect(report).toContain("[import]");
    expect(report).toContain("[call]");
    expect(report).toContain("--- Refactoring Recommendations ---");
  });

  it("registers all 4 code-intel tools into ToolRegistry", () => {
    const registry = new ToolRegistry();
    registerCodeIntelTools(registry, { repoRoot: TEST_DIR });

    expect(registry.has("repo_architecture_map")).toBe(true);
    expect(registry.has("lsp_workspace_symbols")).toBe(true);
    expect(registry.has("lsp_hover_type")).toBe(true);
    expect(registry.has("symbol_impact_analysis")).toBe(true);

    const tools = registry.list();
    expect(tools.every((t) => t.readOnly)).toBe(true);
  });
});
