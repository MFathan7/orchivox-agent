import { z } from "zod";
import { sourceHash } from "../ide/structural-search";
import { readText, type HashlineLifecycle } from "./hashline-edit";
import type { ToolRegistry } from "./registry";

const Notebook = z.object({ nbformat: z.literal(4), cells: z.array(z.object({ cell_type: z.enum(["code", "markdown", "raw"]), source: z.union([z.string(), z.array(z.string())]) }).passthrough()) }).passthrough();
async function load(path: string) {
  if (Bun.file(path).size > 10 * 1024 * 1024) throw new Error("Notebook exceeds the 10 MiB limit.");
  const text = await readText(path);
  return { text, book: Notebook.parse(JSON.parse(text)) };
}

export function registerNotebookTools(registry: ToolRegistry, lifecycle: HashlineLifecycle = {}): void {
  registry.register({ name: "read_notebook", description: "Read Jupyter notebook v4 cell source without executing it. Returns zero-based cell indices and fileHash for guarded edit_notebook_cell. Does not dump large outputs or image attachments.",
    parameters: z.object({ filePath: z.string().min(1), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(30).default(10) }), readOnly: true, concurrency: "shared",
    async execute(input) {
      const args = input as { filePath: string; offset: number; limit: number };
      const { text, book } = await load(args.filePath);
      let chars = 0;
      const cells = [];
      for (let index = args.offset; index < Math.min(book.cells.length, args.offset + args.limit); index++) {
        const cell = book.cells[index], source = Array.isArray(cell.source) ? cell.source.join("") : cell.source;
        const preview = source.slice(0, Math.min(10_000, 35_000 - chars));
        if (chars >= 35_000) break;
        cells.push({ index, type: cell.cell_type, id: cell.id, source: preview, truncated: preview.length < source.length });
        chars += preview.length;
      }
      return JSON.stringify({ fileHash: sourceHash(text), cells, totalCells: book.cells.length,
        nextOffset: args.offset + cells.length < book.cells.length ? args.offset + cells.length : undefined });
    },
  });
  registry.register({ name: "edit_notebook_cell", description: "Replace one Jupyter notebook v4 cell source without executing code. Requires fileHash from read_notebook, preserves notebook metadata and other cells, and clears output/execution_count on an edited code cell.",
    parameters: z.object({ filePath: z.string().min(1), index: z.number().int().nonnegative(), source: z.string().max(100_000), expectedHash: z.string().min(1) }), readOnly: false,
    async execute(input) {
      const args = input as { filePath: string; index: number; source: string; expectedHash: string };
      const { text, book } = await load(args.filePath);
      if (sourceHash(text) !== args.expectedHash) throw new Error("Notebook changed; read it again before editing.");
      const cell = book.cells[args.index];
      if (!cell) throw new Error("Cell index is outside this notebook.");
      cell.source = args.source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      if (cell.cell_type === "code") { cell.outputs = []; cell.execution_count = null; }
      const after = JSON.stringify(book, null, 1) + "\n";
      await lifecycle.onBeforeModify?.(args.filePath);
      if (await readText(args.filePath) !== text) throw new Error("Notebook changed during preparation; no edit applied.");
      await Bun.write(args.filePath, after); await lifecycle.onAfterModify?.(args.filePath, after);
      return `Updated cell ${args.index} in ${args.filePath}; no code executed.`;
    },
  });
}
