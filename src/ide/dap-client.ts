import { dirname } from "node:path";
import { createConnection } from "node:net";
import { encodeFrame, FrameDecoder, StdioFramedTransport, type MessageHandler } from "./framing";

export interface DapClientOptions {
  command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; host?: string; port?: number; launchType?: string; timeoutMs?: number;
}
interface DapTransport { send(message: unknown): void; onMessage(handler: MessageHandler): void; onClose(handler: (error: Error) => void): void; close(): Promise<void> }
export type DebugState = "disconnected" | "connecting" | "running" | "stopped" | "terminated" | "failed";
export class DapClient {
  private transport?: DapTransport;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly waits = new Map<string, Set<{ resolve: (value: any) => void; reject: (error: Error) => void }>>();
  private readonly breakpoints = new Map<string, number[]>();
  private threadId?: number;
  private outputText = "";
  outputTruncated = false;
  private revision = 0;
  private closing?: Promise<void>;
  private transportCleanup: Promise<void> = Promise.resolve();
  private ownership?: "launch" | "attach";
  state: DebugState = "disconnected";
  capabilities: Record<string, any> = {};
  constructor(private readonly options: DapClientOptions) {}
  get output() { return this.outputText.split("\n"); }
  get kind() { return this.ownership; }
  private async connect(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.closing) throw new Error("This debug client has closed; start a fresh session.");
    if (this.transport) throw new Error("Debug adapter is already connected.");
    this.state = "connecting";
    const transport = this.options.command ? new StdioFramedTransport(this.options.command, this.options.args ?? [], { cwd: this.options.cwd, env: this.options.env, killTree: true, label: "Debug adapter", maxStderrBytes: 64000, maxMessageBytes: 8 * 1024 * 1024 })
      : this.options.host && this.options.port ? await connectSocket(this.options.host, this.options.port, signal, this.options.timeoutMs ?? 30000) : undefined;
    if (!transport) throw new Error("Configure a debug adapter command or host/port.");
    this.transport = transport; transport.onMessage((message) => this.receive(message)); transport.onClose((error) => this.lost(error));
    if (signal?.aborted) { await this.close(); signal.throwIfAborted(); }
  }
  private lost(error: Error) {
    if (this.state !== "terminated" && !this.closing) this.state = "failed";
    for (const pending of [...this.pending.values()]) pending.reject(error);
    for (const waits of [...this.waits.values()]) for (const wait of [...waits]) wait.reject(error);
    const transport = this.transport; this.transport = undefined;
    if (transport) this.transportCleanup = Promise.all([this.transportCleanup, transport.close().catch(() => {})]).then(() => {});
  }
  private request(command: string, args: unknown, signal?: AbortSignal, timeoutMs = this.options.timeoutMs ?? 30000): Promise<any> {
    signal?.throwIfAborted(); const transport = this.transport;
    if (!transport) return Promise.reject(new Error("Debug adapter is disconnected."));
    const seq = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); this.pending.delete(seq); };
      const cancel = () => { cleanup(); reject(signal?.reason ?? new Error("Debug request cancelled.")); };
      const timer = setTimeout(() => { cleanup(); const error = new Error(`DAP ${command} timed out. The call was not replayed.`); reject(error); this.lost(error); }, timeoutMs);
      this.pending.set(seq, { resolve: (value) => { cleanup(); resolve(value); }, reject: (error) => { cleanup(); reject(error); } });
      signal?.addEventListener("abort", cancel, { once: true });
      try { transport.send({ seq, type: "request", command, arguments: args }); } catch (error) { cleanup(); reject(error); }
      if (signal?.aborted) cancel();
    });
  }
  private event(name: string, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const set = this.waits.get(name) ?? new Set(); this.waits.set(name, set);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); set.delete(wait); if (!set.size) this.waits.delete(name); };
      const wait = { resolve: (value: any) => { cleanup(); resolve(value); }, reject: (error: Error) => { cleanup(); reject(error); } };
      const cancel = () => { cleanup(); reject(signal?.reason ?? new Error("Debug event wait cancelled.")); };
      const timer = setTimeout(() => wait.reject(new Error(`DAP ${name} event timed out.`)), this.options.timeoutMs ?? 30000);
      set.add(wait); signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    });
  }
  private receive(raw: unknown) {
    if (!raw || typeof raw !== "object") return; const message = raw as Record<string, any>;
    if (message.type === "response") {
      const pending = this.pending.get(message.request_seq); if (!pending) return;
      if (message.success === false) pending.reject(new Error(String(message.message ?? "Debug adapter rejected the request.").slice(0, 2000))); else pending.resolve(message.body ?? {});
    } else if (message.type === "event") {
      const body = message.body ?? {};
      if (message.event === "output" && typeof body.output === "string") { const text = this.outputText + body.output; this.outputTruncated ||= text.length > 50000; this.outputText = text.slice(-50000); }
      if (message.event === "stopped") { this.state = "stopped"; this.threadId = Number.isInteger(body.threadId) && body.threadId > 0 ? body.threadId : undefined; this.revision++; }
      if (message.event === "continued") { this.state = "running"; this.threadId = undefined; this.revision++; }
      if (message.event === "terminated" || message.event === "exited") { this.state = "terminated"; this.threadId = undefined; this.revision++; }
      for (const wait of [...(this.waits.get(message.event) ?? [])]) wait.resolve(body);
    } else if (message.type === "request") {
      this.transport?.send({ seq: ++this.sequence, type: "response", request_seq: message.seq, command: message.command, success: false, message: "Reverse execution requests are not supported. Configure and launch explicitly." });
    }
  }
  async start(program: string, options: { args?: string[]; cwd?: string; stopOnEntry?: boolean; launch?: Record<string, unknown>; signal?: AbortSignal } = {}): Promise<string> {
    await this.begin("launch", { ...options.launch, program, args: options.args ?? [], cwd: options.cwd ?? dirname(program), stopOnEntry: options.stopOnEntry ?? true, noDebug: false }, options.signal);
    return `Debug launch initialized for ${program}; state=${this.state}.`;
  }
  async attach(arguments_: Record<string, unknown>, signal?: AbortSignal) { await this.begin("attach", arguments_, signal); return `Debug attach initialized; state=${this.state}.`; }
  private async begin(kind: "launch" | "attach", arguments_: Record<string, unknown>, signal?: AbortSignal) {
    this.ownership = kind;
    try {
      await this.connect(signal);
      const waiter = new AbortController(), combined = signal ? AbortSignal.any([signal, waiter.signal]) : waiter.signal;
      const initialized = this.event("initialized", combined); initialized.catch(() => {});
      try {
        this.capabilities = await this.request("initialize", { clientID: "orchivox", adapterID: this.options.launchType ?? "orchivox", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path", supportsVariableType: true, supportsRunInTerminalRequest: false }, signal);
        const started = this.request(kind, { ...arguments_, request: kind, name: "Orchivox", ...(this.options.launchType ? { type: this.options.launchType } : {}) }, signal); started.catch(() => {});
        await Promise.race([initialized, started.then(() => initialized)]);
        for (const [file, lines] of this.breakpoints) await this.sendBreakpoints(file, lines, signal);
        if (this.capabilities.supportsConfigurationDoneRequest) await this.request("configurationDone", {}, signal);
        await started; if (this.state === "connecting") this.state = "running";
      } finally { waiter.abort(); }
    } catch (error) { await this.close(); this.state = "failed"; throw error; }
  }
  configureBreakpoints(file: string, lines: number[]) { this.breakpoints.set(file, [...new Set(lines)].sort((a, b) => a - b)); }
  async setBreakpoint(file: string, line: number, signal?: AbortSignal) { const lines = this.breakpoints.get(file) ?? []; this.configureBreakpoints(file, [...lines, line]); return this.sendBreakpoints(file, this.breakpoints.get(file)!, signal); }
  async setBreakpoints(file: string, lines: number[], signal?: AbortSignal) { this.configureBreakpoints(file, lines); return this.sendBreakpoints(file, this.breakpoints.get(file)!, signal); }
  private async sendBreakpoints(file: string, lines: number[], signal?: AbortSignal) {
    const body = await this.request("setBreakpoints", { source: { path: file }, breakpoints: lines.map((line) => ({ line })) }, signal);
    return { breakpoints: (body.breakpoints ?? []).slice(0, 100) };
  }
  async threads(signal?: AbortSignal) { const body = await this.request("threads", {}, signal); return (body.threads ?? []).slice(0, 100); }
  private async stoppedThread(signal?: AbortSignal): Promise<number> {
    if (this.state !== "stopped") throw new Error(`Debuggee is ${this.state}; wait for a stopped event before stepping or inspecting frames/variables.`);
    const id = this.threadId ?? (await this.threads(signal))[0]?.id;
    if (!Number.isInteger(id)) throw new Error("No stopped thread was reported."); return id;
  }
  async resume(action: "continue" | "next" | "stepIn", signal?: AbortSignal) {
    const threadId = await this.stoppedThread(signal), revision = this.revision; this.state = "running";
    try { await this.request(action, { threadId }, signal); if (this.revision === revision) this.threadId = undefined; return { state: this.state, threadId }; }
    catch (error) { if (this.revision === revision && this.state === "running") this.state = "stopped"; throw error; }
  }
  continueExecution(signal?: AbortSignal) { return this.resume("continue", signal); }
  next(signal?: AbortSignal) { return this.resume("next", signal); }
  stepIn(signal?: AbortSignal) { return this.resume("stepIn", signal); }
  async frames(signal?: AbortSignal) { const body = await this.request("stackTrace", { threadId: await this.stoppedThread(signal), startFrame: 0, levels: 20 }, signal); return (body.stackFrames ?? []).slice(0, 20); }
  async stackTrace(signal?: AbortSignal): Promise<string> { return JSON.stringify(await this.frames(signal)); }
  async inspectVariables(frameId?: number, signal?: AbortSignal) {
    await this.stoppedThread(signal); const target = frameId ?? (await this.frames(signal))[0]?.id;
    if (!Number.isInteger(target)) throw new Error("No stack frame to inspect.");
    const scopes = await this.request("scopes", { frameId: target }, signal), result = [];
    for (const scope of (scopes.scopes ?? []).slice(0, 10)) {
      const body = await this.request("variables", { variablesReference: scope.variablesReference, start: 0, count: 100 }, signal);
      result.push({ name: scope.name, variables: (body.variables ?? []).slice(0, 100), partial: (body.variables?.length ?? 0) >= 100 });
    }
    return { frameId: target, scopes: result, partial: (scopes.scopes?.length ?? 0) > 10 || result.some((scope) => scope.partial) };
  }
  async variables(frameId?: number, signal?: AbortSignal): Promise<string> { return JSON.stringify(await this.inspectVariables(frameId, signal)); }
  async terminate(signal?: AbortSignal) {
    if (this.ownership !== "launch") throw new Error("Attached debuggees are preserved. Use disconnect to release this adapter connection.");
    if (this.capabilities.supportsTerminateRequest) await this.request("terminate", { restart: false }, signal);
    await this.close(); return "Owned debug launch closed; termination requested.";
  }
  async close() {
    return this.closing ??= (async () => {
      if (this.transport) await this.request("disconnect", { restart: false, terminateDebuggee: this.ownership === "launch" }, undefined, 500).catch(() => {});
      const transport = this.transport; this.transport = undefined;
      this.lost(new Error("Debug client closed.")); await transport?.close(); await this.transportCleanup; this.state = "disconnected";
    })();
  }
}

async function connectSocket(host: string, port: number, signal?: AbortSignal, timeoutMs = 30000): Promise<DapTransport> {
  signal?.throwIfAborted(); const socket = createConnection({ host, port });
  const decoder = new FrameDecoder(8 * 1024 * 1024); let handler: MessageHandler | undefined, closed: ((error: Error) => void) | undefined, failure: Error | undefined;
  const queue: unknown[] = [];
  const ended = (error: Error) => { if (failure) return; failure = error; closed?.(error); socket.destroy(); };
  socket.on("data", (data) => { try { for (const message of decoder.push(typeof data === "string" ? Buffer.from(data) : data)) { if (handler) handler(message); else if (queue.length < 100) queue.push(message); else throw new Error("DAP startup queue exceeded 100 messages."); } } catch (error) { ended(error instanceof Error ? error : new Error(String(error))); } });
  socket.on("error", ended); socket.on("close", () => ended(new Error("Debug adapter socket closed.")));
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); socket.off("connect", connected); socket.off("error", failed); };
    const connected = () => { cleanup(); resolve(); }, failed = (error: Error) => { cleanup(); socket.destroy(); reject(error); };
    const cancel = () => failed(signal?.reason ?? new Error("Debug connection cancelled."));
    const timer = setTimeout(() => failed(new Error("Debug adapter connection timed out.")), timeoutMs);
    socket.once("connect", connected); socket.once("error", failed); signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
  });
  return { send: (message) => { if (failure) throw failure; socket.write(encodeFrame(message)); }, onMessage: (next) => { handler = next; for (const message of queue.splice(0)) next(message); }, onClose: (next) => { closed = next; if (failure) next(failure); }, close: async () => { ended(new Error("Debug socket disconnected.")); } };
}
