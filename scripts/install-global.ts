import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import packageJson from "../package.json";
import { readInstallRecord, resolveInstallPaths, writeInstallRecord } from "../src/installer/paths";
import { detectLibc, platformId } from "../src/installer/platform";

console.log("==> Building standalone Orchivox binary...");
const buildProc = Bun.spawn(["bun", "run", "scripts/build-binary.ts"], {
  cwd: process.cwd(),
  stdout: "inherit",
  stderr: "inherit",
});
const buildExit = await buildProc.exited;
if (buildExit !== 0) {
  console.error("Failed to build standalone binary.");
  process.exit(buildExit);
}

const sourceBinary = join(process.cwd(), "orchivox");
if (!existsSync(sourceBinary)) {
  console.error("Binary not found at:", sourceBinary);
  process.exit(1);
}

const userHome = homedir();
const localBin = join(userHome, ".local", "bin");
const paths = resolveInstallPaths();
const orchivoxBinDir = paths.binDir;

mkdirSync(localBin, { recursive: true });
mkdirSync(orchivoxBinDir, { recursive: true });

const targetLocalBin = join(localBin, "orchivox");
const targetOrchivoxBin = paths.binaryPath;

function safeInstallBinary(dest: string) {
  try {
    if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false })) {
      unlinkSync(dest);
    }
  } catch {
    // Ignore error if destination file doesn't exist.
  }
  copyFileSync(sourceBinary, dest);
  chmodSync(dest, 0o755);
  console.log(`Installed standalone binary to: ${dest}`);
}

safeInstallBinary(targetLocalBin);
safeInstallBinary(targetOrchivoxBin);

// Save source repository metadata so `orchivox update` can locate and rebuild from source:
const installSourcePath = join(paths.baseDir, "install_source.json");
try {
  writeFileSync(
    installSourcePath,
    JSON.stringify(
      {
        sourceDir: process.cwd(),
        installedAt: new Date().toISOString(),
        version: packageJson.version,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`Saved install source metadata to: ${installSourcePath}`);
} catch {
  // Best-effort metadata save.
}

try {
  const existing = readInstallRecord(paths);
  writeInstallRecord(paths, {
    schema: 1,
    version: packageJson.version,
    platform: platformId(process.platform, process.arch, detectLibc()),
    channel: "stable",
    method: "source",
    binary: relative(paths.baseDir, targetOrchivoxBin),
    installed_at: new Date().toISOString(),
    previous:
      existing && existing.version !== packageJson.version ? existing.version : existing?.previous,
  });
  console.log(`Saved install metadata to: ${paths.installFile}`);
} catch {
  // Best-effort metadata save.
}

// Clean up stale ~/.bun/bin/orchivox if present so it doesn't shadow the binary
const bunBin = join(userHome, ".bun", "bin", "orchivox");
try {
  const stat = lstatSync(bunBin, { throwIfNoEntry: false });
  if (stat) {
    unlinkSync(bunBin);
    // Point bun/bin to the new compiled binary as well
    Bun.spawnSync(["ln", "-sf", targetLocalBin, bunBin]);
    console.log(`Updated ~/.bun/bin/orchivox -> ${targetLocalBin}`);
  }
} catch {
  // Ignored if .bun/bin is not present.
}

console.log("\n==> Verifying global installation:");
const testProc = Bun.spawn([targetLocalBin, "--version"], {
  stdout: "inherit",
  stderr: "inherit",
});
await testProc.exited;

console.log("\nOrchivox global installation complete! You can now run `orchivox` from anywhere.\n");
