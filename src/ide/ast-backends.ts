import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runToolProcess } from "../tools/process";

export type AstLanguage = "typescript" | "javascript" | "python" | "rust" | "go";
export interface AstBackendOptions { astGrep?: string | null; python?: string | null }
export interface AstMatch { start: number; end: number; line: number; column: number; captures: Map<string, string> }
const Range = z.object({ byteOffset: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }) });
const Node = z.object({ text: z.string(), range: Range });
const Matches = z.array(Node.extend({ metaVariables: z.object({ single: z.record(z.string(), Node), multi: z.record(z.string(), z.array(Node)) }).optional() }));

export class AstBackends {
  readonly astGrep: string | null;
  readonly python: string | null;
  constructor(options: AstBackendOptions = {}) {
    this.astGrep = options.astGrep === undefined ? Bun.which("ast-grep") : options.astGrep;
    this.python = options.python === undefined ? Bun.which("python3") ?? Bun.which("python") : options.python;
  }
  capabilities() {
    return ["typescript", "javascript", "python", "rust", "go"].map((language) => ({ language,
      backend: language === "typescript" || language === "javascript" ? "typescript" : "ast-grep",
      search: language === "typescript" || language === "javascript" || !!this.astGrep && (language !== "python" || !!this.python),
      rewrite: language === "typescript" || language === "javascript" || language === "python" && !!this.astGrep && !!this.python,
      requirement: language === "typescript" || language === "javascript" ? "Built in" : language === "python" ? "ast-grep >=0.50 and Python >=3.8" : "ast-grep >=0.50; rewrite unavailable",
    }));
  }
  async validatePython(source: string, signal?: AbortSignal) {
    if (!this.python) throw new Error("Python AST operations require a Python 3.8+ executable; no edit applied.");
    const result = await runToolProcess([this.python, "-I", "-S", "-c", "import ast,sys; assert sys.version_info >= (3,8), 'Python 3.8+ is required'; ast.parse(sys.stdin.read(), filename='<orchivox>', mode='exec')"], { cwd: tmpdir(), input: source, signal, timeoutMs: 10000, maxBytes: 8000 });
    if (result.code || result.truncated) throw new Error(`Cannot parse Python source: ${result.error.trim() || "validator failed"}`);
  }
  async matches(source: string, pattern: string, language: "python" | "rust" | "go", signal?: AbortSignal): Promise<AstMatch[]> {
    signal?.throwIfAborted();
    if (!this.astGrep) throw new Error(`AST ${language} search requires ast-grep >=0.50 on PATH. Inspect ast_search operation: capabilities; no text-search fallback is used.`);
    if (language === "python") await this.validatePython(source, signal);
    const directory = await mkdtemp(join(tmpdir(), "orchivox-ast-"));
    try {
      const config = join(directory, "sgconfig.yml"); await writeFile(config, "ruleDirs: []\n", { mode: 0o600 });
      const invoke = async (query: string[], validatePattern = false) => {
        const result = await runToolProcess([this.astGrep!, "run", "--config", config, "--custom-languages", "ignore", "--lang", language, ...query, "--json=compact", "--stdin"], { cwd: directory, signal, input: source, timeoutMs: 10000, maxBytes: 2 * 1024 * 1024 });
        if (result.truncated || result.code !== 0 && result.code !== 1) throw new Error(`AST parser failed: ${result.error.trim() || "output budget exceeded or unsupported CLI"}`);
        if (validatePattern) {
          const tree = /^Debug Sexp:\r?\n([^\r\n]+)/m.exec(result.error)?.[1];
          if (!tree || /\(ERROR(?:\s|\))/.test(tree)) throw new Error("Cannot parse AST pattern, or the ast-grep CLI lacks the expected debug protocol.");
        }
        return Matches.parse(JSON.parse(result.output || "[]"));
      };
      if ((await invoke(["--kind", "ERROR"])).length) throw new Error(`Cannot parse ${language} source: parser error nodes were found.`);
      // Raw metavariables can appear as ERROR nodes in the debug tree before ast-grep expands them.
      const validationPattern = pattern.replace(/\${1,3}[A-Za-z_][\w]*/g, "ORCHIVOX_CAPTURE");
      await invoke(["--pattern", validationPattern, "--debug-query=sexp"], true);
      const results = await invoke(["--pattern", pattern]), bytes = Buffer.from(source);
      const offset = (byte: number) => { if (byte > bytes.length) throw new Error("Parser returned an invalid byte offset."); return bytes.subarray(0, byte).toString("utf8").length; };
      return results.map((node) => {
        const start = offset(node.range.byteOffset.start), end = offset(node.range.byteOffset.end);
        if (end < start || source.slice(start, end) !== node.text) throw new Error("Parser returned a stale or invalid source range.");
        const captures = new Map<string, string>();
        for (const [name, value] of Object.entries(node.metaVariables?.single ?? {})) captures.set(`$${name}`, value.text);
        for (const [name, values] of Object.entries(node.metaVariables?.multi ?? {})) captures.set(`$$$${name}`, values.length ? source.slice(offset(values[0].range.byteOffset.start), offset(values.at(-1)!.range.byteOffset.end)) : "");
        const prefix = source.slice(0, start), line = prefix.split("\n").length, column = start - prefix.lastIndexOf("\n");
        return { start, end, line, column, captures };
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
