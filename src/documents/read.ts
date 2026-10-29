import { extname } from "node:path";

import type { DocumentsConfig } from "../config/loader";
import { detectDocumentKind } from "./detect";
import { readDocxText } from "./docx";
import { readPdfText } from "./pdf";
import { DocumentReadError, type DocumentExtract } from "./types";
import { readXlsxText } from "./xlsx";
import { inspectZip } from "./zip";

export interface ReadDocumentOptions {
  pages?: string;
  sheet?: string;
  range?: string;
}

export async function readDocumentExtract(
  filePath: string,
  options: ReadDocumentOptions,
  config: DocumentsConfig,
): Promise<DocumentExtract> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new DocumentReadError(`File not found: ${filePath}`, "not_found");
  }
  const maxBytes = config.max_file_mb * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new DocumentReadError(
      `File is ${(file.size / 1024 / 1024).toFixed(1)} MB, above the ${config.max_file_mb} MB limit.`,
      "too_large",
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const extension = extname(filePath).toLowerCase();
  if (extension === ".doc" || extension === ".xls") {
    throw new DocumentReadError(
      "Legacy .doc and .xls files are not supported. Convert them to .docx or .xlsx with LibreOffice first.",
      "unsupported",
    );
  }
  if (extension === ".docm" || extension === ".xlsm") {
    throw new DocumentReadError(
      "Macro-enabled Office files are not supported. Remove the macros and save as .docx or .xlsx.",
      "unsupported",
    );
  }

  const kind = detectDocumentKind(bytes, filePath);

  if (kind === "pdf") {
    return readPdfText(bytes, {
      pages: options.pages,
      maxPages: config.max_pages,
    });
  }

  if (kind === "text") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new DocumentReadError("The file is not valid UTF-8 text.", "invalid");
    }
    return { kind, text };
  }

  if (kind === "docx" || kind === "xlsx") {
    await inspectZip(bytes, {
      maxEntries: 2_000,
      maxUncompressedBytes: config.max_uncompressed_mb * 1024 * 1024,
    });
    if (kind === "docx") {
      return { kind, text: await readDocxText(bytes) };
    }
    const result = await readXlsxText(bytes, {
      sheet: options.sheet,
      range: options.range,
      maxRows: config.max_sheet_rows,
      maxColumns: config.max_sheet_columns,
    });
    return {
      kind,
      text: result.text,
      sheetNames: result.sheetNames,
      selectedSheet: result.selectedSheet,
      range: result.range,
      truncated: result.truncated,
    };
  }

  if (kind === "image") {
    throw new DocumentReadError(
      "Images are not read by read_document. Use inspect_image with imagePath to get a vision report.",
      "unsupported",
    );
  }

  throw new DocumentReadError(
    "Unsupported binary file. Convert it to UTF-8 text, Markdown, or CSV before reading.",
    "unsupported",
  );
}
