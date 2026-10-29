#!/usr/bin/env bun
import { main } from "../src/index.ts";

main(process.argv.slice(2)).catch((error) => {
  const cancelled =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "cancelled";
  if (!cancelled) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(cancelled ? 130 : 1);
});
