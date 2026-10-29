import mammoth from "mammoth";

import { DocumentReadError } from "./types";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_full, hex: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      } catch {
        return "";
      }
    })
    .replace(/&#(\d+);/g, (_full, decimal: string) => {
      try {
        return String.fromCodePoint(Number(decimal));
      } catch {
        return "";
      }
    })
    .replace(/&([a-z]+);/gi, (full, name: string) => ENTITIES[name.toLowerCase()] ?? full);
}

function inlineText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
      .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
      .replace(/<img[^>]*>/gi, "[embedded image omitted]")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .trim();
}

function tableToMarkdown(table: string): string {
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => {
    const cells = [...row[1]!.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((cell) =>
      inlineText(cell[2]!).replace(/\|/g, "\\|").replace(/\n+/g, "<br>"),
    );
    return cells;
  });
  if (rows.length === 0) return "";
  const columns = Math.max(...rows.map((row) => row.length));
  if (columns === 0) return "";
  const padded = rows.map((row) => [...row, ...Array.from({ length: columns - row.length }, () => "")]);
  const header = padded[0]!;
  const separator = Array.from({ length: columns }, () => "---");
  return [header, separator, ...padded.slice(1)]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

export function docxHtmlToMarkdown(html: string): string {
  const tables: string[] = [];
  let output = html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (full) => {
    const index = tables.length;
    tables.push(tableToMarkdown(full));
    return `\n\n@@DOCX_TABLE_${index}@@\n\n`;
  });

  output = output
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_full, level: string, inner: string) => {
      return `\n\n${"#".repeat(Number(level))} ${inlineText(inner)}\n\n`;
    })
    .replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_full, inner: string) => {
      const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(
        (item) => `- ${inlineText(item[1]!)}`,
      );
      return items.length > 0 ? `\n\n${items.join("\n")}\n\n` : "";
    })
    .replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_full, inner: string) => {
      const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(
        (item, index) => `${index + 1}. ${inlineText(item[1]!)}`,
      );
      return items.length > 0 ? `\n\n${items.join("\n")}\n\n` : "";
    })
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_full, inner: string) => {
      const text = inlineText(inner);
      return text.length > 0 ? `\n\n${text}\n\n` : "\n\n";
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  output = decodeEntities(output);
  output = output.replace(/@@DOCX_TABLE_(\d+)@@/g, (_full, index: string) => tables[Number(index)] ?? "");
  return output
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function readDocxText(bytes: Uint8Array): Promise<string> {
  try {
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes) },
      {
        convertImage: mammoth.images.imgElement(async () => ({
          src: "embedded-image-omitted",
        })),
      },
    );
    const text = docxHtmlToMarkdown(result.value);
    if (text.trim().length === 0) {
      throw new DocumentReadError("The DOCX has no extractable text.", "no_text");
    }
    return text;
  } catch (error) {
    if (error instanceof DocumentReadError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new DocumentReadError(`Could not read the DOCX: ${message}`, "invalid");
  }
}
