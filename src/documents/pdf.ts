import { getDocumentProxy } from "unpdf";

import { DocumentReadError, type DocumentExtract } from "./types";

export interface PdfReadOptions {
  pages?: string;
  maxPages: number;
}

export interface PdfReadResult extends DocumentExtract {
  kind: "pdf";
  totalPages: number;
  pages: number[];
  scannedPages: number[];
  nextPage?: number;
}

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

export function selectPdfPages(
  spec: string | undefined,
  totalPages: number,
  maxPages: number,
): number[] {
  if (totalPages < 1) {
    throw new DocumentReadError("The PDF has no pages.", "invalid");
  }
  const normalized = spec?.trim().toLowerCase();
  if (!normalized || normalized === "all") {
    return Array.from({ length: Math.min(totalPages, maxPages) }, (_, index) => index + 1);
  }

  const wanted = new Set<number>();
  for (const rawPart of normalized.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) {
      throw new DocumentReadError(`Invalid page range "${part}". Use 1-5 or 1,3,8.`, "invalid");
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start < 1 || end < start || end > totalPages) {
      throw new DocumentReadError(
        `Page range ${part} is outside 1-${totalPages}.`,
        "invalid",
      );
    }
    for (let page = start; page <= end; page += 1) wanted.add(page);
  }

  const pages = [...wanted].sort((left, right) => left - right);
  if (pages.length === 0) {
    throw new DocumentReadError("No pages were selected.", "invalid");
  }
  if (pages.length > maxPages) {
    throw new DocumentReadError(
      `Selected ${pages.length} pages, but the limit is ${maxPages} pages per read. Read a smaller range.`,
      "too_many_pages",
    );
  }
  return pages;
}

export async function readPdfText(
  bytes: Uint8Array,
  options: PdfReadOptions,
): Promise<PdfReadResult> {
  let pdf: PdfDocument | undefined;
  try {
    pdf = await getDocumentProxy(bytes, {
      maxImageSize: 16_777_216,
      verbosity: 0,
    });
    const totalPages = pdf.numPages;
    const pages = selectPdfPages(options.pages, totalPages, options.maxPages);
    const parts: string[] = [];
    const scannedPages: number[] = [];

    for (const pageNumber of pages) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => {
            if (!("str" in item)) return "";
            return `${item.str}${item.hasEOL ? "\n" : " "}`;
          })
          .join("")
          .trim();
        if (text.length < 20) scannedPages.push(pageNumber);
        parts.push(`--- page ${pageNumber} ---\n${text}`);
      } finally {
        page.cleanup();
      }
    }

    if (scannedPages.length === pages.length) {
      throw new DocumentReadError(
        `No extractable text on pages ${pages.join(", ")}. The PDF is likely scanned. Use OCR or read the pages as images.`,
        "no_text",
      );
    }

    const lastPage = pages[pages.length - 1] ?? 0;
    return {
      kind: "pdf",
      text: parts.join("\n\n"),
      totalPages,
      pages,
      scannedPages,
      nextPage: lastPage < totalPages ? lastPage + 1 : undefined,
    };
  } catch (error) {
    if (error instanceof DocumentReadError) throw error;
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (/password|encrypt/i.test(`${name} ${message}`)) {
      throw new DocumentReadError(
        "This PDF is encrypted or password-protected. Remove the password or extract the text before reading.",
        "encrypted",
      );
    }
    throw new DocumentReadError(`Could not read the PDF: ${message}`, "invalid");
  } finally {
    if (pdf) {
      const destroy = (pdf as unknown as { destroy?: () => Promise<void> }).destroy;
      if (destroy) await destroy.call(pdf).catch(() => undefined);
    }
  }
}
