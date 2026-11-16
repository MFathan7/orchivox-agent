import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINUX_DESKTOP_HELPER } from "./linux-helper";
import { killProcessTree } from "../tools/process-tree";

export class DesktopFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
export async function linuxDesktopRequest(program: string, request: Record<string, unknown>, signal: AbortSignal, options: { env?: Record<string, string> } = {}): Promise<any> {
  signal.throwIfAborted(); let directory: string | undefined;
  if (["screenshot", "capture"].includes(String(request.action))) { directory = await mkdtemp(join(tmpdir(), "orchivox-desktop-")); request = { ...request, capturePath: join(directory, "capture.png") }; }
  let child: ReturnType<typeof Bun.spawn> | undefined, force: ReturnType<typeof setTimeout> | undefined;
  try {
    signal.throwIfAborted(); child = Bun.spawn([program, "-I", "-c", LINUX_DESKTOP_HELPER], { stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32", ...(options.env ? { env: { ...process.env, ...options.env } } : {}) });
    const stop = () => { try { child?.kill("SIGTERM"); } catch {} force = setTimeout(() => { if (child?.exitCode === null) killProcessTree(child, { force: true }); }, 1000); };
    signal.addEventListener("abort", stop, { once: true });
    const read = async (stream: ReadableStream<Uint8Array>, keep: boolean) => {
      const chunks: Uint8Array[] = []; let bytes = 0;
      for await (const chunk of stream) { if (keep) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { killProcessTree(child!, { force: true }); throw new DesktopFailure("desktop_protocol_limit", "Desktop response exceeded 8 MiB."); } chunks.push(chunk); } }
      return Buffer.concat(chunks).toString("utf8");
    };
    try {
      (child.stdin as Bun.FileSink).write(JSON.stringify(request)); (child.stdin as Bun.FileSink).end(); if (signal.aborted) stop();
      const [output, _stderr, code] = await Promise.all([read(child.stdout as ReadableStream<Uint8Array>, true), read(child.stderr as ReadableStream<Uint8Array>, false), child.exited]);
      signal.throwIfAborted(); if (code !== 0) throw new DesktopFailure("desktop_helper_failed", "Linux desktop helper failed. Verify Python, PyGObject, pyatspi, and desktop-session access.");
      const result = JSON.parse(output); if (!result.ok) throw new DesktopFailure(String(result.code ?? "desktop_failed"), String(result.message ?? "Desktop request failed.")); return result.value;
    } finally { signal.removeEventListener("abort", stop); if (force) clearTimeout(force); }
  } finally { if (child?.exitCode === null) { killProcessTree(child, { force: true }); await child.exited.catch(() => {}); } if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {}); }
}
