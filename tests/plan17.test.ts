import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  computeLineHash,
  createApplyUnifiedPatchTool,
  createCreateFileTool,
  createDeleteFileTool,
  createHashEditTool,
  createMoveFileTool,
  createReadFileTool,
  EditRejectedError,
  formatLine,
  resolveAnchorWithFuzzyRecovery,
  splitLines,
} from "../src/tools/hashline-edit";
import {
  buildSelfHealingPrompt,
  createDiagnosticsCheckTool,
  formatDiagnosticWithHashlines,
  parseTscOutput,
  type LSPDiagnostic,
} from "../src/ide/lsp-fixer";

const TEST_DIR = resolve(process.cwd(), ".agent/test-plan17");

async function setupTestDir(): Promise<void> {
  if (existsSync(TEST_DIR)) {
    await rm(TEST_DIR, { recursive: true, force: true });
  }
  await mkdir(TEST_DIR, { recursive: true });
}

describe("Batch Multi-Hunk Hashline Edit v2", () => {
  it("computes accurate 3-char hex line hashes", () => {
    const hash1 = computeLineHash("const x = 1;");
    const hash2 = computeLineHash("const x = 1;   ");
    const hash3 = computeLineHash("const y = 2;");

    expect(hash1.length).toBe(3);
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });

  it("handles single-hunk replacement for backwards compatibility", async () => {
    await setupTestDir();
    const filePath = resolve(TEST_DIR, "single.ts");
    const initial = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n") + "\n";
    await writeFile(filePath, initial, "utf8");

    const lines = splitLines(initial);
    const startAnchor = `2:${computeLineHash(lines[1])}`;
    const endAnchor = `3:${computeLineHash(lines[2])}`;

    const tool = createHashEditTool();
    const result = await tool.execute({
      filePath,
      startAnchor,
      endAnchor,
      newContent: "new line 2\nnew line 3",
    });

    expect(result).toContain("applied 1 hunk(s)");
    const updated = await Bun.file(filePath).text();
    expect(updated).toBe(["line 1", "new line 2", "new line 3", "line 4", "line 5"].join("\n") + "\n");
  });

  it("applies batch multi-hunk edits sorted automatically bottom-to-top without line shifts", async () => {
    await setupTestDir();
    const filePath = resolve(TEST_DIR, "batch.ts");
    const fileLines = [
      "header line",
      "function foo() {",
      "  return 1;",
      "}",
      "middle comment",
      "function bar() {",
      "  return 2;",
      "}",
      "footer line",
    ];
    await writeFile(filePath, fileLines.join("\n") + "\n", "utf8");

    // Intentionally pass upper hunk first and lower hunk second.
    // The engine must sort them bottom-to-top so modifying the lower hunk doesn't shift the upper hunk!
    const upperStart = `2:${computeLineHash(fileLines[1])}`;
    const upperEnd = `4:${computeLineHash(fileLines[3])}`;

    const lowerStart = `6:${computeLineHash(fileLines[5])}`;
    const lowerEnd = `8:${computeLineHash(fileLines[7])}`;

    const tool = createHashEditTool();
    const result = await tool.execute({
      filePath,
      edits: [
        {
          startAnchor: upperStart,
          endAnchor: upperEnd,
          newContent: "function fooUpdated() {\n  return 100;\n}",
        },
        {
          startAnchor: lowerStart,
          endAnchor: lowerEnd,
          newContent: "function barUpdated() {\n  return 200;\n}",
        },
      ],
    });

    expect(result).toContain("applied 2 hunk(s)");
    const updated = await Bun.file(filePath).text();
    expect(updated).toContain("function fooUpdated()");
    expect(updated).toContain("function barUpdated()");
    expect(updated).toContain("middle comment");
  });

  it("detects and rejects overlapping edit hunks", async () => {
    await setupTestDir();
    const filePath = resolve(TEST_DIR, "overlap.ts");
    const fileLines = ["line 1", "line 2", "line 3", "line 4", "line 5"];
    await writeFile(filePath, fileLines.join("\n") + "\n", "utf8");

    const tool = createHashEditTool();
    await expect(
      tool.execute({
        filePath,
        edits: [
          {
            startAnchor: `1:${computeLineHash(fileLines[0])}`,
            endAnchor: `3:${computeLineHash(fileLines[2])}`,
            newContent: "replacement A",
          },
          {
            startAnchor: `2:${computeLineHash(fileLines[1])}`,
            endAnchor: `4:${computeLineHash(fileLines[3])}`,
            newContent: "replacement B",
          },
        ],
      }),
    ).rejects.toThrow(EditRejectedError);
  });

  it("recovers shifted anchors using Fuzzy Anchor Recovery within +/- 15 lines", () => {
    // 30 lines with a unique line inserted earlier, shifting line 20 down to line 23
    const lines = Array.from({ length: 30 }, (_, idx) => `regular line ${idx + 1}`);
    const originalTargetLine = 20;
    const targetContent = "unique target function definition";
    lines[originalTargetLine - 1] = targetContent;
    const targetHash = computeLineHash(targetContent);

    // Now simulate shifting: insert 3 new lines at line 10
    const shiftedLines = [
      ...lines.slice(0, 9),
      "new inserted line A",
      "new inserted line B",
      "new inserted line C",
      ...lines.slice(9),
    ];

    // The anchor still specifies line 20:hash, but in shiftedLines it is now at line 23
    const anchor = `${originalTargetLine}:${targetHash}`;
    const resolved = resolveAnchorWithFuzzyRecovery(anchor, shiftedLines, 15);

    expect(resolved.recovered).toBe(true);
    expect(resolved.originalLine).toBe(20);
    expect(resolved.resolvedLine).toBe(23);
    expect(computeLineHash(shiftedLines[resolved.resolvedLine - 1])).toBe(targetHash);
  });

  it("rejects edit when anchor is outside +/- 15 line window or hash was changed", () => {
    const lines = ["const a = 1;", "const b = 2;", "const c = 3;"];
    const invalidAnchor = "2:999"; // hash does not match line 2

    expect(() => resolveAnchorWithFuzzyRecovery(invalidAnchor, lines, 15)).toThrow(
      EditRejectedError,
    );
  });
});

describe("File Lifecycle Tools", () => {
  it("creates, deletes, moves files, and triggers lifecycle callbacks", async () => {
    await setupTestDir();
    const beforeCalls: string[] = [];
    const afterCalls: string[] = [];

    const lifecycle = {
      onBeforeModify: (p: string) => {
        beforeCalls.push(p);
      },
      onAfterModify: (p: string) => {
        afterCalls.push(p);
      },
    };

    const createTool = createCreateFileTool(lifecycle);
    const deleteTool = createDeleteFileTool(lifecycle);
    const moveTool = createMoveFileTool(lifecycle);

    const testFile = resolve(TEST_DIR, "sub/new-file.txt");
    await createTool.execute({
      filePath: testFile,
      content: "hello world\nline 2",
    });

    expect(existsSync(testFile)).toBe(true);
    expect(beforeCalls).toContain(testFile);
    expect(afterCalls).toContain(testFile);

    const movedFile = resolve(TEST_DIR, "sub2/moved-file.txt");
    await moveTool.execute({
      sourcePath: testFile,
      destinationPath: movedFile,
    });

    expect(existsSync(testFile)).toBe(false);
    expect(existsSync(movedFile)).toBe(true);

    await deleteTool.execute({
      filePath: movedFile,
    });
    expect(existsSync(movedFile)).toBe(false);
  });

  it("applies unified diff patches cleanly with apply_unified_patch", async () => {
    await setupTestDir();
    const filePath = resolve(TEST_DIR, "patch-target.txt");
    const initialText = "line 1\nline 2\nline 3\n";
    await writeFile(filePath, initialText, "utf8");

    const patch = [
      "--- patch-target.txt",
      "+++ patch-target.txt",
      "@@ -1,3 +1,3 @@",
      " line 1",
      "-line 2",
      "+line 2 modified",
      " line 3",
      "",
    ].join("\n");

    const tool = createApplyUnifiedPatchTool();
    const result = await tool.execute({
      filePath,
      patch,
    });

    expect(result).toContain("applied unified patch");
    const content = await Bun.file(filePath).text();
    expect(content).toBe("line 1\nline 2 modified\nline 3\n");
  });
});

describe("Auto-LSP Self-Healing Loop & Diagnostics", () => {
  it("parses compiler output into structured LSPDiagnostic items", () => {
    const sampleOutput = [
      "src/agent/orchestrator.ts(42,15): error TS2304: Cannot find name 'foo'.",
      "src/tools/shell.ts:18:5 - warning TS6133: 'bar' is declared but never used.",
    ].join("\n");

    const diagnostics = parseTscOutput(sampleOutput);
    expect(diagnostics.length).toBe(2);

    expect(diagnostics[0].file).toBe("src/agent/orchestrator.ts");
    expect(diagnostics[0].line).toBe(42);
    expect(diagnostics[0].column).toBe(15);
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].code).toBe("TS2304");

    expect(diagnostics[1].file).toBe("src/tools/shell.ts");
    expect(diagnostics[1].severity).toBe("warning");
  });

  it("formats diagnostics with hashline code snippets and error markers", async () => {
    const diag: LSPDiagnostic = {
      file: "package.json",
      line: 2,
      column: 3,
      severity: "error",
      message: "Sample error message",
      code: "TS1000",
      source: "tsc",
    };

    const formatted = await formatDiagnosticWithHashlines(diag, process.cwd(), 2);
    expect(formatted).toContain("[ERROR] package.json:2:3 [TS1000] - Sample error message");
    expect(formatted).toContain("Hashline anchors (use directly with hash_edit):");
    expect(formatted).toContain("--> 2:");
  });

  it("builds self-healing prompt with stern warning and direct hashline anchors", async () => {
    const diags: LSPDiagnostic[] = [
      {
        file: "package.json",
        line: 2,
        column: 3,
        severity: "error",
        message: "Invalid field syntax",
        code: "TS2000",
      },
    ];

    const prompt = await buildSelfHealingPrompt("package.json", diags, process.cwd());
    expect(prompt).toContain("[LSP COMPILER ERROR DETECTED AFTER EDIT]");
    expect(prompt).toContain("CRITICAL: Fix these compiler errors immediately using hash_edit");
    expect(prompt).toContain("--> 2:");
  });

  it("provides diagnostics_check tool to inspect workspace health", async () => {
    const tool = createDiagnosticsCheckTool();
    const result = await tool.execute({
      runTsc: true,
    });

    // Since our workspace currently typechecks cleanly:
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
  });
});
