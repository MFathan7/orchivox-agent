import { describe, expect, it } from "bun:test";

import {
  contextUsagePercent,
  formatContextUsage,
  formatContextWindow,
} from "../src/tui/format";

describe("context usage formatting", () => {
  it("formats context usage with a percentage", () => {
    expect(formatContextUsage(224_500, 449_000)).toBe("224.5K (50%)");
    expect(formatContextUsage(0, 262_144)).toBe("0 (0%)");
    expect(formatContextUsage(262_144, 262_144)).toBe("262.1K (100%)");
    expect(formatContextUsage(224_500)).toBe("224.5K");
  });

  it("formats context windows", () => {
    expect(formatContextWindow(262_144)).toBe("262.1K");
    expect(formatContextWindow(1_047_576)).toBe("1M");
    expect(formatContextWindow(undefined)).toBe("unknown");
  });

  it("clamps percentages", () => {
    expect(contextUsagePercent(300_000, 262_144)).toBe(100);
    expect(contextUsagePercent(0, 262_144)).toBe(0);
    expect(contextUsagePercent(100, undefined)).toBeUndefined();
  });
});
