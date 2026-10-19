import { describe, expect, it } from "bun:test";

import {
  collapsePastedText,
  expandPastedText,
  pastedPlaceholderAfter,
  pastedPlaceholderBefore,
} from "../src/tui/paste";

describe("pasted text", () => {
  it("collapses three or more lines", () => {
    const pasted = collapsePastedText("one\ntwo\nthree\nfour");
    expect(pasted?.label).toBe("[Pasted 4 lines]");
    expect(pasted?.text).toBe("one\ntwo\nthree\nfour");
  });

  it("keeps short pastes as plain text", () => {
    expect(collapsePastedText("one\ntwo")).toBeNull();
  });

  it("collapses long single-line pastes", () => {
    const pasted = collapsePastedText("x".repeat(151));
    expect(pasted?.label).toBe("[Pasted 1 line]");
  });

  it("normalizes CRLF before measuring", () => {
    const pasted = collapsePastedText("one\r\ntwo\r\nthree");
    expect(pasted?.label).toBe("[Pasted 3 lines]");
    expect(pasted?.text).toBe("one\ntwo\nthree");
  });

  it("expands placeholders back to the full text", () => {
    const entries = [{ label: "[Pasted 2 lines]", text: "line one\nline two" }];
    expect(expandPastedText("check this [Pasted 2 lines] please", entries)).toBe(
      "check this line one\nline two please",
    );
  });

  it("expands duplicate placeholders in order", () => {
    const entries = [
      { label: "[Pasted 2 lines]", text: "first\npaste" },
      { label: "[Pasted 2 lines]", text: "second\npaste" },
    ];
    expect(expandPastedText("[Pasted 2 lines] and [Pasted 2 lines]", entries)).toBe(
      "first\npaste and second\npaste",
    );
  });

  it("finds a placeholder before or after the cursor", () => {
    const text = "before [Pasted 4 lines] after";
    expect(pastedPlaceholderBefore(text, 23)).toEqual({ start: 7, end: 23 });
    expect(pastedPlaceholderAfter(text, 7)).toEqual({ start: 7, end: 23 });
  });
});
