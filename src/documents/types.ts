export type DocumentKind = "pdf" | "text" | "docx" | "xlsx" | "image" | "unsupported";

export type DocumentErrorCode =
  | "not_found"
  | "too_large"
  | "unsupported"
  | "encrypted"
  | "invalid"
  | "no_text"
  | "too_many_pages";

export class DocumentReadError extends Error {
  constructor(
    message: string,
    readonly code: DocumentErrorCode,
  ) {
    super(message);
    this.name = "DocumentReadError";
  }
}

export interface DocumentExtract {
  kind: DocumentKind;
  /** Extracted text for the selected pages or the whole text file. */
  text: string;
  totalPages?: number;
  pages?: number[];
  /** Pages that had no extractable text, usually because they are scans. */
  scannedPages?: number[];
  /** First page that was not read because of the page budget. */
  nextPage?: number;
  sheetNames?: string[];
  selectedSheet?: string;
  range?: string;
  truncated?: boolean;
}
