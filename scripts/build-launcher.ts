#!/usr/bin/env bun
import { chmodSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outfile = resolve(root, "bin", "launcher.mjs");

const result = await Bun.build({
  entrypoints: [resolve(root, "src", "installer", "launcher.ts")],
  target: "node",
  format: "esm",
  minify: true,
  banner: "#!/usr/bin/env node",
  outdir: resolve(root, "bin"),
  naming: { entry: "launcher.mjs" },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

chmodSync(outfile, 0o755);
console.log(`built ${outfile}`);
