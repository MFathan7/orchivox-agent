import { deepStrictEqual, strictEqual } from "node:assert";
import { pageSize, search } from "./src";

const failures: string[] = [];
try {
  for (const [input, expected] of [[0, 1], [1, 1], [9, 9], [12.7, 12], [200, 100], [NaN, 20], [Infinity, 20]]) strictEqual(pageSize(input), expected);
} catch { failures.push("page-size bounds"); }
try {
  const records = [{ id: "b", name: "Beta" }, { id: "a", name: "ALPHA" }, { id: "c", name: "alphabet" }];
  deepStrictEqual(search(records, "  AlPhA  "), ["a", "c"]);
  deepStrictEqual(search(records, ""), ["b", "a", "c"]);
  deepStrictEqual(search(records, "unknown"), []);
} catch { failures.push("query normalization and order"); }
if (failures.length > 0) {
  console.error(`Failed: ${failures.join(", ")}`);
  process.exitCode = 1;
} else console.log("Both behaviors verified.");
