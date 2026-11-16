import { workspaceRoot } from "./workspace";
import { killProcessTree } from "./process-tree";

export class ToolProcessTimeoutError extends Error {}

export async function runToolProcess(argv: string[], options: { signal?: AbortSignal; cwd?: string; timeoutMs?: number; input?: string; maxBytes?: number } = {}): Promise<{ output: string; error: string; code: number; truncated: boolean }> {
  options.signal?.throwIfAborted();
  const child = Bun.spawn(argv, { cwd: options.cwd ?? workspaceRoot(process.cwd()), stdin: options.input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32" });
  const stop = () => killProcessTree(child, { force: true });
  let timedOut = false, truncated = false, total = 0;
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 30_000);
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      const remaining = (options.maxBytes ?? 50_000) - total;
      if (remaining > 0) chunks.push(chunk.slice(0, remaining));
      total += chunk.length;
      if (total > (options.maxBytes ?? 50_000)) { truncated = true; stop(); }
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    if (options.input !== undefined) { (child.stdin as Bun.FileSink).write(options.input); (child.stdin as Bun.FileSink).end(); }
    const [output, error, code] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
    options.signal?.throwIfAborted();
    if (timedOut) throw new ToolProcessTimeoutError(`Tool process timed out after ${options.timeoutMs ?? 30_000}ms.`);
    return { output, error, code, truncated };
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", stop);
    if (child.exitCode === null) { stop(); await child.exited; }
  }
}
