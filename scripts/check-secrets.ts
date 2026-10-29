import { existsSync } from "node:fs";

import { scanTextForSecrets } from "../src/security/secrets";

const SKIP_PREFIXES = ["node_modules/", ".git/"];

function git(args: string[]) {
  return Bun.spawnSync(["git", ...args], { cwd: process.cwd() });
}

const trackedResult = git(["ls-files", "-z"]);
if (trackedResult.exitCode !== 0) {
  console.error(trackedResult.stderr.toString().trim() || "git ls-files failed");
  process.exit(1);
}

const files = trackedResult.stdout
  .toString()
  .split("\0")
  .filter((file) => file.length > 0);

let failed = false;

if (files.includes(".agent/secrets.yaml")) {
  console.error("FAIL .agent/secrets.yaml is tracked by git");
  failed = true;
}

const secretsFile = Bun.file(".agent/secrets.yaml");
if (await secretsFile.exists()) {
  const ignored = git(["check-ignore", "-q", ".agent/secrets.yaml"]);
  if (ignored.exitCode !== 0) {
    console.error("FAIL .agent/secrets.yaml exists but is not ignored by git");
    failed = true;
  }
}

for (const file of files) {
  if (SKIP_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
  if (!existsSync(file)) continue;
  const handle = Bun.file(file);
  if (handle.size > 2_000_000) continue;
  const text = await handle.text();
  if (text.includes("\0")) continue;
  const findings = scanTextForSecrets(text);
  for (const finding of findings) {
    console.error(
      `FAIL ${file}:${finding.line} ${finding.kind}: ${finding.preview}`,
    );
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`No secrets found in ${files.length} tracked files.`);
