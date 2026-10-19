import { describe, expect, it } from "bun:test";

import type { ChatEntryView } from "../src/tui/app";
import { selectWindow } from "../src/tui/viewport";

function entry(id: string, lines: number): ChatEntryView {
  return {
    id,
    role: "assistant",
    text: Array.from({ length: lines }, (_, index) => `line ${index}`).join("\n"),
  };
}

describe("chat scroll window", () => {
  const entries = [entry("a", 10), entry("b", 10), entry("c", 10)];

  it("shows the newest entry at the bottom", () => {
    expect(selectWindow(entries, 80, 10, 0, false).map((item) => item.id)).toEqual(["c"]);
  });

  it("shows older entries as the offset grows", () => {
    expect(selectWindow(entries, 80, 10, 10, false).map((item) => item.id)).toEqual(["b", "c"]);
    expect(selectWindow(entries, 80, 10, 20, false).map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
