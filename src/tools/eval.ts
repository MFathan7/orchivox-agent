import { z } from "zod";
import { currentTurnContext, runWithTurnContext, type TurnContext } from "../agent/turn-context";
import type { AgentTool, ToolRegistry } from "./registry";
import { CODE_MODE_FULL_TOOLS } from "./sandbox-bridge";
import { workspaceRoot } from "./workspace";

function javascriptKernel(): void {
  const requireBuiltin = process.getBuiltinModule("module").createRequire(process.execPath);
  const readline = requireBuiltin("node:readline") as typeof import("node:readline");
  const { format } = requireBuiltin("node:util") as typeof import("node:util");
  const state = Object.create(null);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const lines = readline.createInterface({ input: process.stdin });
  void (async () => {
    for await (const line of lines) {
      const input = JSON.parse(line);
      let output = "";
      const append = (...values: unknown[]) => { output = (output + format(...values) + "\n").slice(0, 50_000); };
      const agent = { async callTool(name: string, args: unknown) {
        const response = await fetch(input.url, { method: "POST", headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" }, body: JSON.stringify({ name, arguments: args }) });
        const result = await response.json() as { content?: unknown; error?: string; is_error?: boolean };
        if (!response.ok || result.is_error) throw new Error(result.error ?? String(result.content));
        return result.content;
      } };
      try {
        const result = await new AsyncFunction("state", "agent", "console", input.code)(state, agent, { log: append, error: append, warn: append, info: append });
        if (result !== undefined) append(result);
        process.stdout.write(JSON.stringify({ id: input.id, output }) + "\n");
      } catch (error) { process.stdout.write(JSON.stringify({ id: input.id, output, error: error instanceof Error ? error.message : String(error) }) + "\n"); }
    }
  })();
}

const PYTHON_KERNEL = `import sys,json,asyncio,ast,inspect,contextlib,urllib.request,traceback
class LimitedOutput:
 def __init__(self): self.text=''
 def write(self,value): self.text=(self.text+str(value))[:50000]; return len(value)
 def flush(self): pass
namespace={'__name__':'__orchivox_eval__','state':{}}
loop=asyncio.new_event_loop(); asyncio.set_event_loop(loop)
for line in sys.stdin:
 request=json.loads(line); output=LimitedOutput()
 class Agent:
  async def callTool(self,name,args):
   def invoke():
    body=json.dumps({'name':name,'arguments':args}).encode()
    req=urllib.request.Request(request['url'],data=body,headers={'Authorization':'Bearer '+request['token'],'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=120) as response: result=json.load(response)
    if result.get('is_error'): raise RuntimeError(str(result.get('content')))
    return result.get('content')
   return await asyncio.to_thread(invoke)
 namespace['agent']=Agent()
 try:
  with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
   result=eval(compile(request['code'],'<orchivox-eval>','exec',flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT),namespace)
   if inspect.isawaitable(result): loop.run_until_complete(result)
  reply={'id':request['id'],'output':output.text}
 except BaseException as error: reply={'id':request['id'],'output':output.text,'error':str(error)}
 sys.stdout.write(json.dumps(reply)+'\\n'); sys.stdout.flush()
`;

interface Kernel {
  child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
  buffer: string;
  decoder: TextDecoder;
  server: ReturnType<typeof Bun.serve>;
  token: string;
  active?: { context?: TurnContext; controller: AbortController; calls: number; maxCalls: number };
  idle?: ReturnType<typeof setTimeout>;
}
const Schema = z.object({ language: z.enum(["typescript", "python"]), code: z.string().min(1).max(100_000),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000), maxToolCalls: z.number().int().min(1).max(100).default(16) });

export class EvalKernels {
  private readonly kernels = new Map<string, Kernel>();
  constructor(private readonly registry: ToolRegistry, private readonly options: { maxKernels?: number; idleMs?: number } = {}) {}
  private key(language: string): string {
    const turn = currentTurnContext();
    return JSON.stringify([turn?.sessionId ?? turn?.runId ?? "ephemeral", turn?.workerId ?? "main", workspaceRoot(process.cwd()), language]);
  }
  private stop(key: string): void {
    const kernel = this.kernels.get(key);
    if (!kernel) return;
    this.kernels.delete(key); clearTimeout(kernel.idle); kernel.active?.controller.abort(); kernel.server.stop(true); kernel.child.kill("SIGKILL");
  }
  dispose(): void { for (const key of this.kernels.keys()) this.stop(key); }
  stopForWorker(workerId: string): void {
    for (const key of this.kernels.keys()) if (JSON.parse(key)[1] === workerId) this.stop(key);
  }
  private create(language: "typescript" | "python"): Kernel {
    const token = crypto.randomUUID();
    const registry = this.registry;
    let kernel: Kernel;
    const allowed = new Set<string>(CODE_MODE_FULL_TOOLS);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 200_000, async fetch(request) {
      if (request.method !== "POST" || request.headers.get("authorization") !== `Bearer ${token}` || !kernel?.active) return new Response("Unavailable", { status: 403 });
      const active = kernel.active;
      const body = await request.json() as { name?: unknown; arguments?: unknown };
      if (typeof body.name !== "string" || !allowed.has(body.name) || ++active.calls > active.maxCalls) return Response.json({ error: "Tool is unavailable in eval or maxToolCalls was reached." }, { status: 403 });
      const name = body.name;
      try { active.context?.consumeNestedTool?.(name); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
      const invoke = () => registry.run({ id: `eval-${active.calls}`, name, arguments: (body.arguments ?? {}) as Record<string, unknown> }, active.context?.mode ?? "build", active.controller.signal);
      const result = active.context ? await runWithTurnContext(active.context, invoke) : await invoke();
      return Response.json({ content: result.content, is_error: result.is_error });
    } });
    try {
      const python = language === "python" ? Bun.which("python3") ?? Bun.which("python") : undefined;
      if (language === "python" && !python) throw new Error("Python interpreter unavailable; install Python or use TypeScript.");
      const command = python ? [python, "-u", "-c", PYTHON_KERNEL] : [process.execPath, "--no-env-file", "--no-install", "--eval", `(${javascriptKernel.toString()})();`];
      const child = Bun.spawn(command, { cwd: workspaceRoot(process.cwd()), env: { ...process.env, BUN_BE_BUN: "1", BUN_OPTIONS: "", NODE_OPTIONS: "" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      kernel = { child, server, token, reader: child.stdout.getReader(), buffer: "", decoder: new TextDecoder() };
      void (async () => { try { for await (const _chunk of child.stderr) { /* Drain without retaining arbitrary kernel output. */ } } catch { /* Kernel may be terminated during a read. */ } })();
      return kernel;
    } catch (error) { server.stop(true); throw error; }
  }
  registerTools(): void {
    this.registry.register({ name: "eval", description: `Run TypeScript or Python in a persistent process scoped to this session, agent, workspace, and language. TypeScript retains values explicitly assigned to state; Python retains top-level variables. Top-level await is supported. agent.callTool bridges existing read/edit tools with permissions and maxToolCalls. This is arbitrary code execution, not a security sandbox; unavailable in Plan. Timeout/cancellation resets that kernel. Capacity ${this.options.maxKernels ?? 8} kernels; idle expiry ${(this.options.idleMs ?? 600_000) / 1000}s. Configure tools.eval_max_kernels and tools.eval_idle_seconds. Responses disclose newKernel; state is not saved across restarts.`,
      parameters: Schema, readOnly: false,
      execute: async (input, context) => {
        const args = Schema.parse(input), key = this.key(args.language);
        context?.signal?.throwIfAborted();
        let kernel = this.kernels.get(key);
        const newKernel = !kernel;
        if (!kernel) {
          if (this.kernels.size >= (this.options.maxKernels ?? 8)) {
            const idle = [...this.kernels].find(([, kernel]) => !kernel.active);
            if (!idle) throw new Error("All eval kernels are busy; wait or raise tools.eval_max_kernels.");
            this.stop(idle[0]);
          }
          kernel = this.create(args.language); this.kernels.set(key, kernel);
        }
        if (kernel.active) throw new Error("This eval kernel is already running a cell.");
        clearTimeout(kernel.idle);
        const controller = new AbortController();
        kernel.active = { context: currentTurnContext(), controller, calls: 0, maxCalls: args.maxToolCalls };
        const id = crypto.randomUUID();
        const stop = () => this.stop(key);
        const timer = setTimeout(stop, args.timeoutMs);
        context?.signal?.addEventListener("abort", stop, { once: true });
        if (context?.signal?.aborted) stop();
        try {
          const code = args.language === "typescript" ? new Bun.Transpiler({ loader: "ts" }).transformSync(args.code) : args.code;
          kernel.child.stdin.write(JSON.stringify({ id, code, url: `http://127.0.0.1:${kernel.server.port}/`, token: kernel.token }) + "\n");
          kernel.child.stdin.flush();
          while (true) {
            const newline = kernel.buffer.indexOf("\n");
            if (newline >= 0) {
              const line = kernel.buffer.slice(0, newline); kernel.buffer = kernel.buffer.slice(newline + 1);
              const reply = JSON.parse(line) as { id: string; output: string; error?: string };
              if (reply.id !== id) throw new Error("Eval protocol lost synchronization; reset the kernel.");
              context?.signal?.throwIfAborted();
              return JSON.stringify({ output: reply.output, ...(reply.error ? { error: reply.error } : {}), stateRetained: true, newKernel });
            }
            const chunk = await kernel.reader.read();
            if (chunk.done || !chunk.value) throw new Error("Eval kernel stopped or exceeded its deadline; state was reset.");
            kernel.buffer += kernel.decoder.decode(chunk.value, { stream: true });
            if (kernel.buffer.length > 300_000) throw new Error("Eval output exceeded the protocol limit; state was reset.");
          }
        } catch (error) { stop(); throw error; }
        finally {
          clearTimeout(timer); context?.signal?.removeEventListener("abort", stop); controller.abort();
          kernel.active = undefined;
          if (this.kernels.get(key) === kernel) {
            this.kernels.delete(key); this.kernels.set(key, kernel);
            kernel.idle = setTimeout(stop, this.options.idleMs ?? 600_000); kernel.idle.unref();
          }
        }
      },
    } satisfies AgentTool);
    this.registry.register({ name: "eval_reset", description: "Stop this agent's TypeScript or Python eval kernel and discard its in-memory variables/state. Does not undo file changes.",
      parameters: z.object({ language: z.enum(["typescript", "python"]) }), readOnly: false,
      execute: (input) => { this.stop(this.key((input as { language: string }).language)); return "Eval kernel reset; files unchanged."; },
    });
  }
}
