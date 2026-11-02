import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { ensureRuntimeTempDir } from "../runtime-temp";
import { truncateHead } from "./output-budget";
import type { AgentTool, ToolRegistry } from "./registry";

export type CodeMode = "read-only" | "full";

export const CODE_MODE_READ_ONLY_TOOLS = [
  "read_file",
  "glob_files",
  "grep_search",
  "json_query",
  "web_fetch",
  "web_search",
] as const;

export const CODE_MODE_FULL_TOOLS = [
  ...CODE_MODE_READ_ONLY_TOOLS,
  "hash_edit",
  "replace_text",
  "create_file",
  "delete_file",
  "move_file",
  "apply_unified_patch",
] as const;

export interface SandboxBridgeOptions {
  root?: string;
  timeoutMs?: number;
  mode?: CodeMode;
  name?: string;
}

export function createSandboxScriptTool(registry: ToolRegistry, options: SandboxBridgeOptions = {}): AgentTool {
  const mode = options.mode ?? "read-only";
  const name = options.name ?? "run_sandbox_script";
  const allowed = new Set<string>(
    mode === "read-only" ? CODE_MODE_READ_ONLY_TOOLS : CODE_MODE_FULL_TOOLS,
  );
  return {
    name,
    description:
      mode === "read-only"
        ? "Run a TypeScript or Python script in an isolated process. Inside the script, `await agent.callTool(name, arguments)` calls read-only tools (read_file, glob_files, grep_search, json_query, web_fetch, web_search) and returns their result text. Use it to batch independent reads and return only the relevant result."
        : "Run a TypeScript or Python script in an isolated process. Inside the script, `await agent.callTool(name, arguments)` calls read-only tools and file edit tools, and returns their result text. Shell, subagents, and tasks are not available.",
    parameters: z.object({
      language: z.enum(["typescript", "python"]),
      code: z.string().min(1),
      timeoutMs: z.number().int().positive().max(120_000).optional(),
    }),
    readOnly: mode === "read-only",
    execute: async (args) => {
      const request = args as { language: "typescript" | "python"; code: string; timeoutMs?: number };
      return runSandboxScript(registry, request, { ...options, mode, allowed });
    },
  };
}

async function runSandboxScript(
  registry: ToolRegistry,
  request: { language: "typescript" | "python"; code: string; timeoutMs?: number },
  options: SandboxBridgeOptions & { mode: CodeMode; allowed: Set<string> },
): Promise<string> {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const toolAbort = new AbortController();
  let callCounter = 0;
  const tempDir = await ensureRuntimeTempDir(options.root ?? globalThis.process.cwd()).catch(
    () => globalThis.process.env.TMPDIR?.trim() || "/tmp",
  );
  const workDir = await mkdtemp(join(tempDir, `sandbox-${process.pid}-`));

  const rpc = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(incoming) {
      const url = new URL(incoming.url);
      if (incoming.method !== "POST" || url.pathname !== "/rpc") {
        return new Response("not found", { status: 404 });
      }
      if (incoming.headers.get("authorization") !== `Bearer ${token}`) {
        return Response.json({ error: "invalid sandbox token" }, { status: 401 });
      }
      const body = (await incoming.json().catch(() => null)) as
        | { name?: unknown; arguments?: unknown }
        | null;
      if (!body || typeof body.name !== "string") {
        return Response.json({ error: "invalid rpc payload" }, { status: 400 });
      }
      if (!options.allowed.has(body.name)) {
        return Response.json(
          { error: `tool "${body.name}" is not allowed in code mode` },
          { status: 403 },
        );
      }
      callCounter += 1;
      const result = await registry.run(
        {
          id: `sandbox-${callCounter}`,
          name: body.name,
          arguments: (body.arguments ?? {}) as Record<string, unknown>,
        },
        options.mode === "read-only" ? "plan" : "build",
        toolAbort.signal,
      );
      return Response.json({ result: { content: result.content, is_error: result.is_error } });
    },
  });

  const rpcUrl = `http://127.0.0.1:${rpc.port}/rpc`;
  try {
    const extension = request.language === "typescript" ? "ts" : "py";
    const scriptPath = `${workDir}/main.${extension}`;
    const wrapper =
      request.language === "typescript"
        ? buildTypeScriptWrapper(request.code, rpcUrl, token)
        : buildPythonWrapper(request.code, rpcUrl, token);
    await Bun.write(scriptPath, wrapper);

    const command =
      request.language === "typescript"
        ? ["bun", scriptPath]
        : [resolvePython(), scriptPath];
    const proc = Bun.spawn(command, {
      cwd: options.root ?? globalThis.process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...collectEnv(), TMPDIR: tempDir },
    });
    const timeoutMs = request.timeoutMs ?? options.timeoutMs ?? 30_000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const kill = (): void => proc.kill();
    const abortTools = (): void => toolAbort.abort();
    timeoutSignal.addEventListener("abort", kill, { once: true });
    timeoutSignal.addEventListener("abort", abortTools, { once: true });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    timeoutSignal.removeEventListener("abort", kill);
    timeoutSignal.removeEventListener("abort", abortTools);

    if (timeoutSignal.aborted) {
      throw new Error(`sandbox script timed out after ${timeoutMs}ms\n${stdout}\n${stderr}`);
    }
    const output = `exit ${exitCode}\n--- stdout ---\n${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`;
    return truncateHead(output, { maxBytes: 50 * 1024 }).text;
  } finally {
    rpc.stop(true);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function buildTypeScriptWrapper(code: string, rpcUrl: string, token: string): string {
  return `type AgentSdk = {
  callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
};

const __rpcUrl = ${JSON.stringify(rpcUrl)};
const __rpcToken = ${JSON.stringify(token)};

const agent: AgentSdk = {
  async callTool(name, args = {}) {
    const response = await fetch(__rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: \`Bearer \${__rpcToken}\` },
      body: JSON.stringify({ name, arguments: args }),
    });
    const body = (await response.json()) as { result?: { content?: unknown; is_error?: boolean }; error?: string };
    if (!response.ok || body.error) throw new Error(body.error ?? \`sandbox rpc failed with status \${response.status}\`);
    if (body.result?.is_error) {
      throw new Error(typeof body.result.content === "string" ? body.result.content : JSON.stringify(body.result.content));
    }
    return body.result?.content;
  },
};
(globalThis as Record<string, unknown>).agent = agent;

${code}
`;
}

function buildPythonWrapper(code: string, rpcUrl: string, token: string): string {
  return `import json
import urllib.request

_rpc_url = ${JSON.stringify(rpcUrl)}
_rpc_token = ${JSON.stringify(token)}


class _AgentSdk:
    def call_tool(self, name, arguments=None):
        payload = json.dumps({"name": name, "arguments": arguments or {}}).encode("utf-8")
        request = urllib.request.Request(
            _rpc_url,
            data=payload,
            headers={"content-type": "application/json", "authorization": "Bearer " + _rpc_token},
            method="POST",
        )
        with urllib.request.urlopen(request) as response:
            body = json.loads(response.read().decode("utf-8"))
        if body.get("error"):
            raise RuntimeError(body["error"])
        result = body.get("result") or {}
        if result.get("is_error"):
            raise RuntimeError(str(result.get("content")))
        return result.get("content")

    callTool = call_tool


agent = _AgentSdk()

${code}
`;
}

function resolvePython(): string {
  return Bun.which("python3") ?? Bun.which("python") ?? "python3";
}

function collectEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(globalThis.process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
