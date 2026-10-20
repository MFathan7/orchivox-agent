import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
const orchivoxBinDir = join(userHome, ".orchivox", "bin");

mkdirSync(localBin, { recursive: true });
mkdirSync(orchivoxBinDir, { recursive: true });

const targetLocalBin = join(localBin, "orchivox");
const targetOrchivoxBin = join(orchivoxBinDir, "orchivox");

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
