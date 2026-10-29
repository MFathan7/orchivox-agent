import { dirname } from "node:path";
import { z } from "zod";

import type { AgentTool, ToolRegistry } from "../tools/registry";
import { encodeFrame, FrameDecoder, StdioFramedTransport, type MessageHandler } from "./framing";

export interface DapClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  host?: string;
  port?: number;
  launchType?: string;
}

interface DapTransport {
  send(message: unknown): void;
  onMessage(handler: MessageHandler): void;
  close(): Promise<void>;
}

interface DapResponse {
  type: "response";
  request_seq: number;
  success?: boolean;
  message?: string;
  body?: unknown;
}

interface DapEvent {
  type: "event";
  event: string;
  body?: unknown;
}

interface StackFrame {
  id: number;
  name: string;
  line: number;
  column: number;
  source?: { path?: string };
}

interface ScopeInfo {
  name: string;
  variablesReference: number;
}

interface VariableInfo {
  name: string;
  value: string;
  type?: string;
}

export class DapClient {
  private readonly command: string | undefined;
  private readonly args: string[];
  private readonly cwd: string | undefined;
  private readonly env: Record<string, string> | undefined;
  private readonly host: string | undefined;
  private readonly port: number | undefined;
  private readonly launchType: string | undefined;
  private transport: DapTransport | undefined;
  private nextSeq = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly eventWaiters = new Map<string, Array<(body: unknown) => void>>();
  private readonly outputLines: string[] = [];
  private readonly breakpointsByFile = new Map<string, number[]>();
  private stoppedThreadId: number | undefined;
  private activeThreadId = 1;

  constructor(options: DapClientOptions) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.host = options.host;
    this.port = options.port;
    this.launchType = options.launchType;
  }

  get output(): string[] {
    return [...this.outputLines];
  }

  async start(program: string, options: { args?: string[]; cwd?: string; stopOnEntry?: boolean } = {}): Promise<string> {
    await this.connect();
    const initialized = this.waitForEvent("initialized");
    await this.request("initialize", {
      clientID: "orchivox",
      adapterID: "orchivox",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsVariableType: true,
      supportsRunInTerminalRequest: false,
    });

    const launch = this.request("launch", {
      request: "launch",
      name: "orchivox",
      ...(this.launchType ? { type: this.launchType } : {}),
      program,
      args: options.args ?? [],
      cwd: options.cwd ?? dirname(program),
      stopOnEntry: options.stopOnEntry ?? true,
      noDebug: false,
    });
    await initialized;
    for (const [file, lines] of this.breakpointsByFile) await this.sendBreakpoints(file, lines);
    await this.request("configurationDone", {});
    await launch;

    return `debug session started for ${program}${options.stopOnEntry === false ? "" : " (stops on entry)"}`;
  }

  async setBreakpoint(file: string, line: number): Promise<string> {
    const lines = this.breakpointsByFile.get(file) ?? [];
    if (!lines.includes(line)) lines.push(line);
    lines.sort((left, right) => left - right);
    this.breakpointsByFile.set(file, lines);
    const summary = await this.sendBreakpoints(file, lines);
    return `breakpoints on ${file}: ${lines.join(", ")}${summary ? `\n${summary}` : ""}`;
  }

  async continueExecution(): Promise<string> {
    const threadId = await this.resolveThreadId();
    await this.request("continue", { threadId });
    this.stoppedThreadId = undefined;
    return `continued thread ${threadId}`;
  }

  async next(): Promise<string> {
    const threadId = await this.resolveThreadId();
    await this.request("next", { threadId, granularity: "line" });
    this.stoppedThreadId = undefined;
    return `stepped over on thread ${threadId}`;
  }

  async stepIn(): Promise<string> {
    const threadId = await this.resolveThreadId();
    await this.request("stepIn", { threadId });
    this.stoppedThreadId = undefined;
    return `stepped into on thread ${threadId}`;
  }

  async stackTrace(): Promise<string> {
    const threadId = await this.resolveThreadId();
    const frames = await this.fetchFrames(threadId);
    if (frames.length === 0) return "no stack frames";
    return frames
      .map((frame, index) => {
        const path = frame.source?.path ? ` ${frame.source.path}` : "";
        return `#${index} ${frame.name}${path}:${frame.line}`;
      })
      .join("\n");
  }

  async variables(frameId?: number): Promise<string> {
    const targetFrame = frameId ?? (await this.fetchFrames(await this.resolveThreadId()))[0]?.id;
    if (targetFrame === undefined) return "no stack frame to inspect";
    const scopes = (await this.request("scopes", { frameId: targetFrame })) as { scopes?: ScopeInfo[] };
    const sections: string[] = [];
    for (const scope of scopes.scopes ?? []) {
      const variables = (await this.request("variables", {
        variablesReference: scope.variablesReference,
      })) as { variables?: VariableInfo[] };
      const lines = (variables.variables ?? []).map((variable) => {
        const type = variable.type ? ` (${variable.type})` : "";
        return `  ${variable.name} = ${variable.value}${type}`;
      });
      sections.push(`${scope.name}:\n${lines.join("\n")}`);
    }
    return sections.length > 0 ? sections.join("\n") : "no variables in scope";
  }

  async terminate(): Promise<string> {
    if (this.transport) {
      try {
        await this.request("terminate", { restart: false });
      } catch {
        // the adapter may have already stopped
      }
      await this.transport.close();
      this.transport = undefined;
    }
    return "debug session terminated";
  }

  registerTools(registry: ToolRegistry): void {
    registry.register(this.debugSessionTool());
  }

  private debugSessionTool(): AgentTool {
    return {
      name: "debug_session",
      description:
        "Drive a debug adapter session. Actions: start, set_breakpoint, continue, next, step_in, stack_trace, variables, terminate. Lines are 1-based.",
      parameters: z.object({
        action: z.enum([
          "start",
          "set_breakpoint",
          "continue",
          "next",
          "step_in",
          "stack_trace",
          "variables",
          "terminate",
        ]),
        program: z.string().optional(),
        programArgs: z.array(z.string()).optional(),
        cwd: z.string().optional(),
        stopOnEntry: z.boolean().optional(),
        file: z.string().optional(),
        line: z.number().int().positive().optional(),
        frameId: z.number().int().nonnegative().optional(),
      }),
      readOnly: false,
      execute: async (args) => {
        const request = args as {
          action: string;
          program?: string;
          programArgs?: string[];
          cwd?: string;
          stopOnEntry?: boolean;
          file?: string;
          line?: number;
          frameId?: number;
        };
        switch (request.action) {
          case "start":
            if (!request.program) throw new Error("action start requires program");
            return this.start(request.program, {
              args: request.programArgs,
              cwd: request.cwd,
              stopOnEntry: request.stopOnEntry,
            });
          case "set_breakpoint":
            if (!request.file || request.line === undefined) {
              throw new Error("action set_breakpoint requires file and line");
            }
            return this.setBreakpoint(request.file, request.line);
          case "continue":
            return this.continueExecution();
          case "next":
            return this.next();
          case "step_in":
            return this.stepIn();
          case "stack_trace":
            return this.stackTrace();
          case "variables":
            return this.variables(request.frameId);
          case "terminate":
            return this.terminate();
          default:
            throw new Error(`unknown debug action "${request.action}"`);
        }
      },
    };
  }

  private async connect(): Promise<void> {
    if (this.transport) return;
    if (this.command) {
      this.transport = new StdioFramedTransport(this.command, this.args, { cwd: this.cwd, env: this.env });
      this.transport.onMessage((message) => this.handleMessage(message));
      return;
    }
    if (this.host !== undefined && this.port !== undefined) {
      this.transport = await connectSocket(this.host, this.port);
      this.transport.onMessage((message) => this.handleMessage(message));
      return;
    }
    throw new Error("DapClient needs either command (stdio) or host and port (socket)");
  }

  private request(command: string, args: unknown): Promise<unknown> {
    const transport = this.transport;
    if (!transport) throw new Error("debug adapter is not connected");
    const seq = this.nextSeq++;
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      transport.send({ seq, type: "request", command, arguments: args });
    });
  }

  private waitForEvent(event: string): Promise<unknown> {
    return new Promise((resolve) => {
      const waiters = this.eventWaiters.get(event) ?? [];
      waiters.push(resolve);
      this.eventWaiters.set(event, waiters);
    });
  }

  private handleMessage(raw: unknown): void {
    const message = raw as Partial<DapResponse> & Partial<DapEvent> & { type?: string };
    if (message.type === "response") {
      const pending = this.pending.get(message.request_seq ?? -1);
      if (!pending) return;
      this.pending.delete(message.request_seq ?? -1);
      if (message.success === false) {
        pending.reject(new Error(message.message ?? `debug adapter command failed`));
      } else {
        pending.resolve(message.body);
      }
      return;
    }
    if (message.type === "event") {
      const event = message.event ?? "";
      const body = message.body;
      if (event === "output") {
        const output = (body as { output?: string }).output;
        if (output) {
          this.outputLines.push(output);
          if (this.outputLines.length > 500) this.outputLines.shift();
        }
      }
      if (event === "stopped") {
        const threadId = (body as { threadId?: number }).threadId;
        if (threadId !== undefined) this.stoppedThreadId = threadId;
      }
      const waiters = this.eventWaiters.get(event) ?? [];
      this.eventWaiters.delete(event);
      for (const waiter of waiters) waiter(body);
    }
  }

  private async resolveThreadId(): Promise<number> {
    if (this.stoppedThreadId !== undefined) return this.stoppedThreadId;
    const body = (await this.request("threads", {})) as { threads?: Array<{ id: number }> };
    const first = body.threads?.[0];
    if (first) this.activeThreadId = first.id;
    return this.activeThreadId;
  }

  private async fetchFrames(threadId: number): Promise<StackFrame[]> {
    const body = (await this.request("stackTrace", {
      threadId,
      startFrame: 0,
      levels: 20,
    })) as { stackFrames?: StackFrame[] };
    return body.stackFrames ?? [];
  }

  private async sendBreakpoints(file: string, lines: number[]): Promise<string> {
    const body = (await this.request("setBreakpoints", {
      source: { path: file },
      breakpoints: lines.map((line) => ({ line })),
      lines,
    })) as { breakpoints?: Array<{ verified: boolean; line?: number }> };
    const verified = (body.breakpoints ?? []).filter((breakpoint) => breakpoint.verified).length;
    return `${verified}/${lines.length} breakpoint(s) verified`;
  }
}

async function connectSocket(host: string, port: number): Promise<DapTransport> {
  const decoder = new FrameDecoder();
  let handler: MessageHandler | undefined;
  const socket = await Bun.connect({
    hostname: host,
    port,
    socket: {
      data(_socket, data) {
        if (!handler) return;
        for (const message of decoder.push(data)) handler(message);
      },
      open() {},
      close() {},
      error() {},
    },
  });
  return {
    send: (message) => {
      socket.write(encodeFrame(message));
    },
    onMessage: (next) => {
      handler = next;
    },
    close: async () => {
      socket.end();
    },
  };
}
