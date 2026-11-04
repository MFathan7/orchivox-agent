export interface ProcessHandle {
  pid: number;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface KillProcessTreeOptions {
  /** Send SIGKILL immediately instead of SIGTERM. */
  force?: boolean;
}

/**
 * Ends the whole process tree, not only the shell. Unix uses the process group
 * created by a detached spawn; Windows uses taskkill /T.
 */
export function killProcessTree(
  proc: ProcessHandle,
  options: KillProcessTreeOptions = {},
): void {
  if (process.platform === "win32") {
    const args = ["taskkill", "/T", "/PID", String(proc.pid)];
    if (options.force) args.splice(2, 0, "/F");
    try {
      Bun.spawnSync(args, { stdout: "ignore", stderr: "ignore" });
    } catch {
      // Fall back to the shell process itself.
    }
    try {
      proc.kill(options.force ? 9 : 15);
    } catch {
      // The process already exited.
    }
    return;
  }

  const signal: NodeJS.Signals = options.force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(options.force ? 9 : 15);
    } catch {
      // The process already exited.
    }
  }
}
