import { describe, expect, it } from "bun:test";

import { displayWidth, wrapText } from "../src/tui/text-wrap";

describe("text wrapping", () => {
  it("wraps words to the display width", () => {
    expect(wrapText("one two three", 7)).toEqual(["one two", "three"]);
  });

  it("preserves explicit newlines", () => {
    expect(wrapText("a\nb", 10)).toEqual(["a", "b"]);
    expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  it("hard-breaks words wider than the line", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("counts wide characters as two columns", () => {
    expect(displayWidth("日本語")).toBe(6);
    expect(wrapText("日本語", 4)).toEqual(["日本", "語"]);
  });

  it("returns one empty line for empty text", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });
});
