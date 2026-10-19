import { describe, expect, it } from "bun:test";

import type { ChatEntryView } from "../src/tui/app";
import { estimateEntryLines, findActivityRowAt } from "../src/tui/viewport";
import {
  activityCalls,
  activitySummary,
  groupToolCalls,
} from "../src/tui/tool-groups";

function call(name: string, detail: string) {
  return {
    name,
    label: name,
    detail,
    argumentsSummary: "{}",
    status: "ok" as const,
  };
}

describe("tool activity groups", () => {
  it("groups reads, searches, commands, and other tools", () => {
    const activity = groupToolCalls([
      call("read_file", "package.json"),
      call("read_file", "src/index.ts"),
      call("grep_search", "TODO"),
      call("bash", "bun test"),
      call("hash_edit", "src/index.ts"),
    ]);

    expect(activitySummary(activity)).toBe("2 reads · 1 search · 1 command");
    expect(activityCalls(activity).map((entry) => entry.detail)).toEqual([
      "package.json",
      "src/index.ts",
      "TODO",
      "bun test",
    ]);
    expect(activity.others.map((entry) => entry.name)).toEqual(["hash_edit"]);
  });

  it("uses singular labels", () => {
    const activity = groupToolCalls([call("read_file", "a.ts"), call("grep_search", "x")]);
    expect(activitySummary(activity)).toBe("1 read · 1 search");
  });

  it("counts expanded activity rows in the height estimate", () => {
    const entry: ChatEntryView = {
      id: "assistant-1",
      role: "assistant",
      text: "done",
      toolCalls: [call("read_file", "a.ts"), call("grep_search", "x")],
    };

    const collapsed = estimateEntryLines(entry, 80, false);
    const expanded = estimateEntryLines(entry, 80, false, new Set([entry.id]));
    expect(expanded).toBe(collapsed + 2);
  });

  it("finds the activity header row for a click", () => {
    const entry: ChatEntryView = {
      id: "assistant-1",
      role: "assistant",
      text: "done",
      thinking: "checking",
      toolCalls: [call("read_file", "a.ts")],
    };

    expect(findActivityRowAt([entry], 80, 40, 0, false, new Set(), 3)?.id).toBe(entry.id);
    expect(findActivityRowAt([entry], 80, 40, 0, false, new Set(), 2)).toBe(entry);
    expect(findActivityRowAt([entry], 80, 40, 0, false, new Set(), 10)).toBeUndefined();
  });
});
