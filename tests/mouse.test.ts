import { describe, expect, it } from "bun:test";

import { isMouseSequence, parseMouseClick, parseMouseWheel } from "../src/tui/mouse";

describe("mouse wheel parsing", () => {
  it("parses wheel up and down", () => {
    expect(parseMouseWheel("\u001b[<64;10;5M")).toBe(1);
    expect(parseMouseWheel("\u001b[<65;10;5M")).toBe(-1);
  });

  it("sums multiple wheel events", () => {
    expect(parseMouseWheel("\u001b[<64;10;5M\u001b[<64;10;5M")).toBe(2);
    expect(parseMouseWheel("\u001b[<64;10;5M\u001b[<65;10;5M")).toBe(0);
  });

  it("ignores non-wheel input", () => {
    expect(parseMouseWheel("hello")).toBe(0);
    expect(parseMouseWheel("\u001b[<0;10;5M")).toBe(0);
    expect(isMouseSequence("\u001b[<64;10;5M")).toBe(true);
    expect(isMouseSequence("[<64;10;5M")).toBe(true);
    expect(isMouseSequence("hello")).toBe(false);
  });

  it("parses left clicks and ignores wheel, release, and motion", () => {
    expect(parseMouseClick("\u001b[<0;10;5M")).toEqual({ x: 10, y: 5, button: 0 });
    expect(parseMouseClick("\u001b[<0;10;5m")).toBeUndefined();
    expect(parseMouseClick("\u001b[<64;10;5M")).toBeUndefined();
    expect(parseMouseClick("\u001b[<32;10;5M")).toBeUndefined();
  });
});
