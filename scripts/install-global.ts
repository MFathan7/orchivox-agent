#!/usr/bin/env bun
import { lstatSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import packageJson from "../package.json";
import { parseInstallArgs, runLocalInstallCommand } from "../src/installer/cli";
import { resolveInstallPaths } from "../src/installer/paths";

async function buildRuntime(): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "scripts/build-binary.ts"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    const detail = (stderr || stdout).trim();
    throw new Error(
      `Build failed with exit code ${code}.${detail ? `\n${detail}` : ""}`,
    );
  }
}

const parsed = parseInstallArgs(process.argv.slice(2));
const sourceBinary = join(process.cwd(), "orchivox");
const extraLinkPaths = process.env.ORCHIVOX_INSTALL_DIR
  ? []
  : [join(homedir(), ".local", "bin", "orchivox")];

let result;
try {
  result = await runLocalInstallCommand({
    binaryPath: sourceBinary,
    version: packageJson.version,
    method: "source",
    parsed,
    launcherVersion: packageJson.version,
    build: buildRuntime,
    extraLinkPaths,
  });
} catch {
  process.exit(1);
}

if (!result) {
  process.exit(0);
}

const paths = resolveInstallPaths();
try {
  writeFileSync(
    join(paths.baseDir, "install_source.json"),
    `${JSON.stringify(
      {
        sourceDir: process.cwd(),
        installedAt: new Date().toISOString(),
        version: packageJson.version,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
} catch {
  // Best-effort metadata save.
}

if (process.platform !== "win32") {
  const bunBin = join(homedir(), ".bun", "bin", "orchivox");
  try {
    const stat = lstatSync(bunBin, { throwIfNoEntry: false });
    if (stat) {
      unlinkSync(bunBin);
      Bun.spawnSync([
        "ln",
        "-sf",
        result.binaryPath,
        bunBin,
      ]);
      console.log(`Updated ${bunBin} -> ${result.binaryPath}`);
    }
  } catch {
    // Ignored if .bun/bin is not present.
  }
}
