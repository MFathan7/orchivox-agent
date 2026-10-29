import type React from "react";

/** One terminal row. The node must render exactly one line. */
export interface RenderRow {
  key: string;
  node: React.ReactNode;
}
