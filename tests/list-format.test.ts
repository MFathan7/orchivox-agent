import { describe, expect, it } from "bun:test";

import { continueList, displayListLine, parseListLine } from "../src/tui/list-format";

describe("list formatting", () => {
  it("detects bullet and ordered markers", () => {
    expect(parseListLine("- item")).toEqual({ indent: "", kind: "bullet", marker: "-" });
    expect(parseListLine("  * item")).toEqual({ indent: "  ", kind: "bullet", marker: "*" });
    expect(parseListLine("1. item")).toEqual({ indent: "", kind: "ordered", marker: "1." });
    expect(parseListLine("  12) item")).toEqual({ indent: "  ", kind: "ordered", marker: "12)" });
    expect(parseListLine("plain text")).toBeNull();
  });

  it("renders bullet markers as a middle dot without changing width", () => {
    expect(displayListLine("- item")).toBe("· item");
    expect(displayListLine("  * item")).toBe("  · item");
    expect(displayListLine("1. item")).toBe("1. item");
    expect(displayListLine("plain text")).toBe("plain text");
    expect(displayListLine("- item").length).toBe("- item".length);
  });

  it("continues bullets and increments ordered lists", () => {
    expect(continueList("- first", 7)).toEqual({ text: "- first\n- ", cursor: 10 });
    expect(continueList("1. first", 8)).toEqual({ text: "1. first\n2. ", cursor: 12 });
    expect(continueList("  3) third", 10)).toEqual({ text: "  3) third\n  4) ", cursor: 16 });
    expect(continueList("plain", 5)).toBeNull();
  });

  it("exits the list on an empty item", () => {
    expect(continueList("- ", 2)).toEqual({ text: "", cursor: 0 });
    expect(continueList("a\n- ", 4)).toEqual({ text: "a\n", cursor: 2 });
    expect(continueList("1. ", 3)).toEqual({ text: "", cursor: 0 });
  });

  it("keeps indentation for nested items", () => {
    expect(continueList("  - nested", 10)).toEqual({ text: "  - nested\n  - ", cursor: 15 });
  });
});
