import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { AgentTool } from "./registry";

export const ReadDatabaseArgsSchema = z.object({
  filePath: z.string().min(1).describe("Path to an existing SQLite database."),
  table: z.string().min(1).max(1024).optional().describe("Inspect one table's columns and rows."),
  query: z.string().trim().min(1).max(20_000).optional().describe("A SELECT or read-only WITH query. Writes, PRAGMA statements, and database attachment are not supported."),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(200).default(50),
  timeoutMs: z.number().int().min(100).max(10_000).default(2000),
}).refine((args) => !(args.table && args.query), "Choose table or query, not both.");

// Keep this function self-contained: the compiled executable runs its source in a cancellable child.
function databaseReaderProcess(): void {
  const requireBuiltin = process.getBuiltinModule("module").createRequire(process.execPath);
  const { Database } = requireBuiltin("bun:sqlite") as typeof import("bun:sqlite");
  const { readFileSync } = requireBuiltin("node:fs") as typeof import("node:fs");
  const input = JSON.parse(readFileSync(0, "utf8")) as {
    filePath: string; table?: string; query?: string; offset: number; limit: number;
  };
  let database: InstanceType<typeof Database> | undefined;
  try {
    database = new Database(input.filePath, { readonly: true, strict: true, safeIntegers: true });
    database.exec("PRAGMA query_only = ON");
    const normalize = (value: unknown): unknown => {
      if (typeof value === "bigint") return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
      if (value instanceof Uint8Array) return { type: "blob", bytes: value.byteLength };
      if (typeof value === "string" && value.length > 2000) return { text: value.slice(0, 2000), truncated: true, characters: value.length };
      return value;
    };
    const normalizeRow = (row: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalize(value)]));
    let schema: unknown;
    let sql = input.query?.replace(/;\s*$/, "");
    if (input.table) {
      const definition = database.query("SELECT sql FROM sqlite_schema WHERE name = ? AND type IN ('table', 'view')").get(input.table);
      if (!definition) throw new Error(`Table or view not found: ${input.table}`);
      schema = definition;
      sql = `SELECT * FROM "${input.table.replace(/"/g, '""')}"`;
    }
    sql ??= "SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name";
    // A derived SELECT keeps the executable statement read-only even if input contains extra SQL.
    const executable = `SELECT * FROM (${sql}\n) AS inspected_rows LIMIT ${input.limit + 1} OFFSET ${input.offset}`;
    const statement = database.prepare(executable);
    const rows: Record<string, unknown>[] = [];
    let bytes = 0;
    let hasMore = false;
    let byteLimit = false;
    try {
      if (statement.toString() !== executable) throw new Error("Use one SELECT or read-only WITH query with literal values; extra statements and unbound parameters are not supported.");
      for (const row of statement.iterate() as IterableIterator<Record<string, unknown>>) {
        if (rows.length >= input.limit) { hasMore = true; break; }
        const normalized = normalizeRow(row);
        const size = Buffer.byteLength(JSON.stringify(normalized), "utf8");
        if (bytes + size > 40_000) { hasMore = true; byteLimit = true; break; }
        rows.push(normalized);
        bytes += size;
      }
      process.stdout.write(JSON.stringify({
        kind: "sqlite", view: input.query ? "query" : input.table ? "table" : "schema",
        ...(schema ? { schema: normalizeRow(schema as Record<string, unknown>) } : {}),
        rows, returned: rows.length, offset: input.offset,
        ...(hasMore && rows.length > 0 ? { nextOffset: input.offset + rows.length } : {}),
        ...(byteLimit ? { truncated: true, hint: "Select fewer columns or shorten large values in the query." } : {}),
      }));
    } finally { statement.finalize(); }
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  } finally { database?.close(); }
}

const READER_SOURCE = `(${databaseReaderProcess.toString()})();`;

export function createReadDatabaseTool(): AgentTool<typeof ReadDatabaseArgsSchema, string> {
  return {
    name: "read_database",
    description: "Inspect an existing SQLite database without a shell. Omit table/query to list schema, pass table for its definition and rows, or query for a SELECT/read-only WITH query. Results are paginated and bounded; use nextOffset for the next page. The connection is read-only in every mode.",
    parameters: ReadDatabaseArgsSchema,
    readOnly: true,
    concurrency: "shared",
    async execute(args, context) {
      context?.signal?.throwIfAborted();
      const request = ReadDatabaseArgsSchema.parse(args);
      if (!(await stat(request.filePath)).isFile()) throw new Error("read_database requires a SQLite file.");
      context?.signal?.throwIfAborted();
      const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "--eval", READER_SOURCE], {
        cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, BUN_BE_BUN: "1", BUN_OPTIONS: "", NODE_OPTIONS: "" },
      });
      let timedOut = false;
      const abort = () => { child.kill("SIGKILL"); };
      const timer = setTimeout(() => { timedOut = true; abort(); }, request.timeoutMs);
      context?.signal?.addEventListener("abort", abort, { once: true });
      if (context?.signal?.aborted) abort();
      try {
        child.stdin.write(JSON.stringify(request));
        child.stdin.end();
        const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        context?.signal?.throwIfAborted();
        if (timedOut) throw new Error(`SQLite inspection timed out after ${request.timeoutMs}ms. Narrow the query or inspect one table.`);
        if (code !== 0) {
          let detail = errors.trim();
          try { detail = JSON.parse(output).error ?? detail; } catch { /* A terminated child may not have returned JSON. */ }
          throw new Error(`SQLite inspection failed: ${detail || `reader exited with code ${code}`}`);
        }
        return output;
      } finally {
        clearTimeout(timer);
        context?.signal?.removeEventListener("abort", abort);
        if (child.exitCode === null) { abort(); await child.exited; }
      }
    },
  };
}
