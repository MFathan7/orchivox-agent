import { basename } from "node:path";
import { z } from "zod";

import type { DocumentsConfig } from "../config/loader";
import { writeDocumentCache } from "../documents/cache";
import { readDocumentExtract } from "../documents/read";
import type { DocumentExtract } from "../documents/types";
import type { AgentTool } from "./registry";

const DEFAULT_CONFIG: DocumentsConfig = {
  max_chars: 24_000,
  max_pages: 20,
  max_sheet_rows: 200,
  max_sheet_columns: 50,
  max_file_mb: 40,
  max_uncompressed_mb: 100,
  preview_chars: 4_000,
  spill_threshold_chars: 24_000,
  image: {
    auto_resize: true,
    max_width: 2_000,
    max_height: 2_000,
    max_base64_bytes: 5_242_880,
  },
};

export const ReadDocumentArgsSchema = z.object({
  filePath: z.string().min(1).describe("Path to the document."),
  pages: z
    .string()
    .min(1)
    .optional()
    .describe("PDF pages to read, for example 1-5, 1,3,8, or all."),
  sheet: z.string().min(1).optional().describe("Reserved for XLSX sheet selection."),
  range: z.string().min(1).optional().describe("Reserved for XLSX range selection."),
  maxChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional per-call character cap, clamped to the configured budget."),
  previewOnly: z
    .boolean()
    .optional()
    .describe("Write the full extract to the cache and return only a preview."),
});
export type ReadDocumentArgs = z.infer<typeof ReadDocumentArgsSchema>;

function pageLabel(pages: number[]): string {
  if (pages.length === 0) return "none";
  const ranges: string[] = [];
  let start = pages[0]!;
  let previous = start;
  for (const page of pages.slice(1)) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = page;
    previous = page;
  }
  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join(",");
}

function header(filePath: string, extract: DocumentExtract): string {
  const parts = [`[document] ${basename(filePath)}`, extract.kind.toUpperCase()];
  if (extract.kind === "pdf") {
    parts.push(`${extract.totalPages} ${extract.totalPages === 1 ? "page" : "pages"}`);
    if (extract.pages && extract.pages.length > 0) {
      parts.push(`read ${pageLabel(extract.pages)}`);
    }
  }
  if (extract.kind === "xlsx") {
    if (extract.sheetNames) parts.push(`${extract.sheetNames.length} sheets`);
    if (extract.selectedSheet) parts.push(`sheet ${extract.selectedSheet}`);
    if (extract.range) parts.push(`range ${extract.range}`);
    if (extract.truncated) parts.push("capped");
  }
  parts.push(`${extract.text.length.toLocaleString("en-US")} chars`);
  if (extract.scannedPages && extract.scannedPages.length > 0) {
    parts.push(`no text on pages ${pageLabel(extract.scannedPages)}`);
  }
  return parts.join(" | ");
}

function nextHint(extract: DocumentExtract, maxPages: number): string {
  if (extract.kind === "pdf" && extract.nextPage !== undefined) {
    const end = Math.min(
      extract.totalPages ?? extract.nextPage + maxPages - 1,
      extract.nextPage + maxPages - 1,
    );
    return `pages ${extract.nextPage}-${end}`;
  }
  if (extract.kind === "xlsx") {
    return extract.selectedSheet
      ? "read a smaller range or another sheet"
      : "pick a sheet and range";
  }
  return "use grep or read_file on the full extract";
}

export function createReadDocumentTool(options: {
  config?: DocumentsConfig;
} = {}): AgentTool<typeof ReadDocumentArgsSchema> {
  const config = { ...DEFAULT_CONFIG, ...options.config, image: { ...DEFAULT_CONFIG.image, ...options.config?.image } };

  return {
    name: "read_document",
    description:
      "Read a PDF, DOCX, XLSX, or text document in bounded sections. Use read_file for code and inspect_image for images. For PDFs, pass pages such as 1-5. Large extracts are written to a cache file and returned as a preview plus path; use grep or read_file on that path for the rest.",
    parameters: ReadDocumentArgsSchema,
    readOnly: true,
    async execute(args) {
      const extract = await readDocumentExtract(
        args.filePath,
        { pages: args.pages, sheet: args.sheet, range: args.range },
        config,
      );
      const cap = Math.min(args.maxChars ?? config.max_chars, config.max_chars);
      const shouldSpill =
        args.previewOnly === true ||
        extract.text.length > cap ||
        extract.text.length > config.spill_threshold_chars;

      if (!shouldSpill) {
        return extract.text.trim().length > 0
          ? `${header(args.filePath, extract)}\n\n${extract.text}`
          : `${header(args.filePath, extract)}\n\n[empty document]`;
      }

      const fullPath = await writeDocumentCache(args.filePath, extract.kind, extract.text);
      const preview = extract.text.slice(0, config.preview_chars);
      const remaining = extract.text.length - preview.length;
      const previewNotice =
        remaining > 0
          ? `\n\n[preview truncated: ${remaining.toLocaleString("en-US")} more characters in the full extract]`
          : "";
      return [
        header(args.filePath, extract),
        "",
        "[preview]",
        preview,
        previewNotice,
        `[full extract] ${fullPath}`,
        `[next] ${nextHint(extract, config.max_pages)}`,
      ].join("\n");
    },
  };
}
