import ExcelJS from "exceljs";

import { DocumentReadError } from "./types";

export interface XlsxReadOptions {
  sheet?: string;
  range?: string;
  maxRows: number;
  maxColumns: number;
}

export interface XlsxReadResult {
  text: string;
  sheetNames: string[];
  selectedSheet?: string;
  range?: string;
  truncated: boolean;
}

interface RangeBounds {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

function columnNumber(letters: string): number {
  let value = 0;
  for (const character of letters.toUpperCase()) {
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  return value;
}

function parseRange(range: string): RangeBounds {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(range.trim());
  if (!match) {
    throw new DocumentReadError(
      `Invalid XLSX range "${range}". Use a range like A1:F50.`,
      "invalid",
    );
  }
  const startRow = Number(match[2]);
  const endRow = Number(match[4]);
  const startColumn = columnNumber(match[1]!);
  const endColumn = columnNumber(match[3]!);
  if (startRow < 1 || endRow < startRow || startColumn < 1 || endColumn < startColumn) {
    throw new DocumentReadError(`Invalid XLSX range "${range}".`, "invalid");
  }
  return { startRow, endRow, startColumn, endColumn };
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("result" in record) return valueText(record.result);
    if (typeof record.text === "string") return record.text;
    if (Array.isArray(record.richText)) {
      return record.richText
        .map((part) =>
          typeof part === "object" && part !== null && "text" in part
            ? String((part as { text: unknown }).text)
            : "",
        )
        .join("");
    }
    if ("error" in record) return String(record.error);
  }
  return String(value);
}

function csvCell(value: unknown): string {
  const text = valueText(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sheetCsv(
  sheet: ExcelJS.Worksheet,
  options: XlsxReadOptions,
  range?: string,
): { csv: string; truncated: boolean } {
  const bounds = range ? parseRange(range) : undefined;
  const startRow = bounds?.startRow ?? 1;
  const startColumn = bounds?.startColumn ?? 1;
  const availableRows = bounds
    ? bounds.endRow - bounds.startRow + 1
    : Math.max(0, sheet.rowCount);
  const availableColumns = bounds
    ? bounds.endColumn - bounds.startColumn + 1
    : Math.max(0, sheet.columnCount);
  const rowCount = Math.min(availableRows, options.maxRows);
  const columnCount = Math.min(availableColumns, options.maxColumns);
  const truncated = availableRows > options.maxRows || availableColumns > options.maxColumns;
  const rows: string[] = [];
  for (let rowIndex = startRow; rowIndex < startRow + rowCount; rowIndex += 1) {
    const row = sheet.getRow(rowIndex);
    const cells: string[] = [];
    for (
      let columnIndex = startColumn;
      columnIndex < startColumn + columnCount;
      columnIndex += 1
    ) {
      cells.push(csvCell(row.getCell(columnIndex).value));
    }
    rows.push(cells.join(","));
  }
  return { csv: rows.join("\n"), truncated };
}

export async function readXlsxText(
  bytes: Uint8Array,
  options: XlsxReadOptions,
): Promise<XlsxReadResult> {
  const workbook = new ExcelJS.Workbook();
  try {
    const input = Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0];
    await workbook.xlsx.load(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypt|password/i.test(message)) {
      throw new DocumentReadError(
        "This XLSX is encrypted or password-protected. Remove the password before reading.",
        "encrypted",
      );
    }
    throw new DocumentReadError(`Could not read the XLSX: ${message}`, "invalid");
  }

  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
  if (sheetNames.length === 0) {
    throw new DocumentReadError("The XLSX has no sheets.", "no_text");
  }

  if (!options.sheet) {
    const lines = ["Sheets:"];
    for (const sheet of workbook.worksheets) {
      lines.push(`- ${sheet.name}: ${sheet.rowCount} rows x ${sheet.columnCount} columns`);
    }
    const first = workbook.worksheets[0]!;
    const preview = sheetCsv(first, options);
    lines.push("", `Preview of ${first.name}:`, preview.csv || "(empty sheet)");
    return {
      text: lines.join("\n"),
      sheetNames,
      truncated: preview.truncated,
    };
  }

  const selected =
    workbook.getWorksheet(options.sheet) ??
    workbook.worksheets.find(
      (sheet) => sheet.name.toLowerCase() === options.sheet!.toLowerCase(),
    );
  if (!selected) {
    throw new DocumentReadError(
      `Sheet "${options.sheet}" was not found. Available sheets: ${sheetNames.join(", ")}.`,
      "invalid",
    );
  }

  const result = sheetCsv(selected, options, options.range);
  return {
    text: `Sheet: ${selected.name}${options.range ? ` range ${options.range}` : ""}\n\n${result.csv || "(empty sheet)"}`,
    sheetNames,
    selectedSheet: selected.name,
    range: options.range,
    truncated: result.truncated,
  };
}
