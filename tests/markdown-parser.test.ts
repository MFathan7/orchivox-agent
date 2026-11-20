import { expect, test } from "bun:test";

import { inlinePlainText, parseInlineSegments, parseMarkdown } from "../src/tui/markdown-parser";
import { markdownRows } from "../src/tui/markdown";
import { rowContent } from "../src/tui/rows";
import { displayWidth } from "../src/tui/text-wrap";
import { getTheme } from "../src/tui/theme";
import { UI_LAYOUTS } from "../src/types/ui-layout";

test("Markdown highlights Windows and POSIX file locations with their full line reference", () => {
  const line = "See @src/入口.ts:10-25, " + String.raw`C:\project\src\app.tsx:12:4, and /home/me/run.sh.`;
  const segments = parseInlineSegments(line);
  expect(segments.filter(({ kind }) => kind === "file").map(({ text }) => text)).toEqual([
    "@src/入口.ts:10-25", String.raw`C:\project\src\app.tsx:12:4`, "/home/me/run.sh",
  ]);
  expect(inlinePlainText(line)).toBe(line);
  expect(parseInlineSegments("Mail editor@sample.md or open notes.md.backup.").some(({ kind }) => kind === "file")).toBe(false);
});

test("Markdown displays escaped HTML literally and decodes entities once", () => {
  expect(inlinePlainText("Keep &amp;lt; and &lt;code&gt;.")).toBe("Keep &lt; and <code>.");
  expect(inlinePlainText("Keep `&lt;`.")).toBe("Keep &lt;.");
  const blocks = parseMarkdown("<p>Keep &amp;lt; and &lt;code&gt;.</p>");
  expect(blocks.map((block) => block.kind === "paragraph" ? inlinePlainText(block.tokens) : block.kind)).toEqual([
    "Keep &lt; and <code>.",
  ]);
});

test("each layout keeps nested tasks, file locations, and table cells readable", () => {
  const file = String.raw`C:\repo\src\app.ts:42`;
  const source = [
    "## Results",
    "",
    "1. Check the entry point",
    "   - [x] Read the file",
    "   - [ ] Run the test",
    "",
    "| File | Result |",
    "| --- | --- |",
    `| ${file} | passed |`,
  ].join("\n");
  const theme = getTheme("tokyonight");
  for (const layout of UI_LAYOUTS) {
    const rows = markdownRows(source, 58, theme, { layout }).map((row) => rowContent(row.node).text);
    expect(rows.join("\n")).toContain(file);
    expect(rows.join("\n")).toContain("passed");
    expect(rows.some((row) => /^ +(?:\[x\]|●) Read the file/.test(row))).toBe(true);
    expect(rows.every((row) => displayWidth(row) <= 58)).toBe(true);

    const narrow = markdownRows(source, 16, theme, { layout }).map((row) => rowContent(row.node).text);
    expect(narrow.join("\n")).toContain("passed");
    expect(narrow.every((row) => displayWidth(row) <= 16)).toBe(true);
  }
});

test("open fences do not gain a closing row during streaming", () => {
  const fence = String.fromCharCode(96).repeat(3);
  const partial = `> ${fence}ts\n> const ready = true;`;
  const complete = `${partial}\n> ${fence}\n\nDone.`;
  const theme = getTheme("tokyonight");
  const rows = (text: string, streaming: boolean) =>
    markdownRows(text, 60, theme, { streaming }).map((row) => rowContent(row.node).text);

  expect(rows(partial, true)).toEqual([`│ ${fence}ts`, "│   const ready = true;"]);
  expect(rows(complete, true)).toContain(`│ ${fence}`);
  expect(rows(complete, true)).toEqual(rows(complete, false));
});
