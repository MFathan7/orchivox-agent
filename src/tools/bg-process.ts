import { z } from "zod";

import type { AgentTool, ToolRegistry } from "./registry";
import { workspaceRoot } from "./workspace";

export interface BgProcessLine {
  index: number;
  stream: "stdout" | "stderr";
  text: string;
  timestamp: number;
}

export type BgProcessStatus = "running" | "ready" | "stopped" | "failed";

export interface BgProcessInfo {
  id: string;
  pid: number;
  command: string;
  status: BgProcessStatus;
  startTime: number;
  exitCode: number | null;
  listeningUrls: string[];
  totalLines: number;
}

export interface BgStartOptions {
  command: string;
  id?: string;
  cwd?: string;
  env?: Record<string, string>;
  waitForReadyRegex?: string;
  readyTimeoutMs?: number;
}

export interface BgLogsOptions {
  lines?: number;
  filterRegex?: string;
  sinceLastRead?: boolean;
}

export interface BgLogsResult {
  processId: string;
  status: BgProcessStatus;
  totalLines: number;
  newLinesCount: number;
  lines: BgProcessLine[];
  formatted: string;
}

const MAX_RING_BUFFER_SIZE = 2000;

const URL_PATTERNS = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s"']*)?/gi,
  /(?:listening|ready|running|server)\s+(?:on|at)\s+(https?:\/\/[^\s"']+)/gi,
  /(?:listening|running|server)\s+(?:on|at)\s+(?:port\s*)?(\d{2,5})/gi,
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/gi,
];

interface ManagedProcess {
  info: BgProcessInfo;
  proc: ReturnType<typeof Bun.spawn>;
  ringBuffer: BgProcessLine[];
  lastReadIndex: number;
  lineCounter: number;
  readyPromise?: Promise<boolean>;
  resolveReady?: (ready: boolean) => void;
}

export class BackgroundProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly defaultCwd: string;
  private idCounter = 0;

  constructor(options?: { defaultCwd?: string }) {
    this.defaultCwd = options?.defaultCwd ?? globalThis.process.cwd();
  }

  async start(options: BgStartOptions): Promise<BgProcessInfo> {
    this.idCounter += 1;
    const id = options.id ?? `bg-${Date.now().toString(36)}-${this.idCounter}`;

    if (this.processes.has(id)) {
      const existing = this.processes.get(id)!;
      if (existing.info.status === "running" || existing.info.status === "ready") {
        throw new Error(`background process with id "${id}" is already running (PID: ${existing.info.pid})`);
      }
    }

    const cwd = options.cwd ?? workspaceRoot(this.defaultCwd);
    const env = { ...globalThis.process.env, ...options.env };

    let resolveReady: ((ready: boolean) => void) | undefined;
    let readyPromise: Promise<boolean> | undefined;

    if (options.waitForReadyRegex) {
      readyPromise = new Promise<boolean>((resolve) => {
        resolveReady = resolve;
      });
    }

    let readyRegex: RegExp | undefined;
    if (options.waitForReadyRegex) {
      try {
        readyRegex = new RegExp(options.waitForReadyRegex, "i");
      } catch {
        readyRegex = undefined;
      }
    }

    const proc = Bun.spawn(["bash", "-c", options.command], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const info: BgProcessInfo = {
      id,
      pid: proc.pid,
      command: options.command,
      status: "running",
      startTime: Date.now(),
      exitCode: null,
      listeningUrls: [],
      totalLines: 0,
    };

    const managed: ManagedProcess = {
      info,
      proc,
      ringBuffer: [],
      lastReadIndex: 0,
      lineCounter: 0,
      readyPromise,
      resolveReady,
    };

    this.processes.set(id, managed);

    const appendLine = (stream: "stdout" | "stderr", text: string) => {
      managed.lineCounter += 1;
      const lineEntry: BgProcessLine = {
        index: managed.lineCounter,
        stream,
        text,
        timestamp: Date.now(),
      };

      managed.ringBuffer.push(lineEntry);
      if (managed.ringBuffer.length > MAX_RING_BUFFER_SIZE) {
        managed.ringBuffer.shift();
      }
      managed.info.totalLines = managed.lineCounter;

      this.detectListeningUrls(text, managed.info.listeningUrls);

      if (readyRegex && readyRegex.test(text) && managed.info.status === "running") {
        managed.info.status = "ready";
        managed.resolveReady?.(true);
      }
    };

    this.streamReader(proc.stdout, (line) => appendLine("stdout", line));
    this.streamReader(proc.stderr, (line) => appendLine("stderr", line));

    proc.exited
      .then((code) => {
        managed.info.exitCode = code;
        managed.info.status = code === 0 ? "stopped" : "failed";
        managed.resolveReady?.(false);
      })
      .catch(() => {
        managed.info.status = "failed";
        managed.resolveReady?.(false);
      });

    if (readyPromise) {
      const timeoutMs = options.readyTimeoutMs ?? 5000;
      await Promise.race([
        readyPromise,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
    }

    return info;
  }

  getLogs(processId: string, options?: BgLogsOptions): BgLogsResult {
    const managed = this.processes.get(processId);
    if (!managed) {
      throw new Error(`background process "${processId}" not found`);
    }

    let filterRe: RegExp | undefined;
    if (options?.filterRegex) {
      try {
        filterRe = new RegExp(options.filterRegex, "i");
      } catch {
        filterRe = undefined;
      }
    }

    let candidateLines = managed.ringBuffer;
    const sinceLastRead = options?.sinceLastRead ?? false;

    if (sinceLastRead) {
      candidateLines = candidateLines.filter((l) => l.index > managed.lastReadIndex);
    }

    if (filterRe) {
      candidateLines = candidateLines.filter((l) => filterRe!.test(l.text));
    }

    const requestedCount = options?.lines ?? 50;
    const selectedLines = candidateLines.slice(-requestedCount);

    const newLinesCount = managed.ringBuffer.filter((l) => l.index > managed.lastReadIndex).length;
    if (managed.ringBuffer.length > 0) {
      managed.lastReadIndex = managed.ringBuffer[managed.ringBuffer.length - 1].index;
    }

    const formattedLines = selectedLines.map(
      (l) => `[${l.stream.toUpperCase()}] ${l.text}`,
    );

    const formatted =
      formattedLines.length > 0
        ? formattedLines.join("\n")
        : "(no logs found matching criteria)";

    return {
      processId,
      status: managed.info.status,
      totalLines: managed.info.totalLines,
      newLinesCount,
      lines: selectedLines,
      formatted,
    };
  }

  list(): BgProcessInfo[] {
    return Array.from(this.processes.values()).map((p) => ({ ...p.info }));
  }

  getProcess(processId: string): BgProcessInfo | undefined {
    return this.processes.get(processId)?.info;
  }

  async stop(processId: string, force = false): Promise<boolean> {
    const managed = this.processes.get(processId);
    if (!managed) {
      return false;
    }

    if (managed.info.status === "stopped" || managed.info.status === "failed") {
      return true;
    }

    try {
      if (force) {
        managed.proc.kill(9);
      } else {
        managed.proc.kill(15);
        await Promise.race([
          managed.proc.exited,
          new Promise((resolve) => setTimeout(resolve, 800)),
        ]);
        if (managed.info.status === "running" || managed.info.status === "ready") {
          managed.proc.kill(9);
        }
      }
    } catch {
      // Process may already have terminated.
    }

    managed.info.status = "stopped";
    return true;
  }

  async stopAll(): Promise<void> {
    const activeIds = Array.from(this.processes.entries())
      .filter(([_, p]) => p.info.status === "running" || p.info.status === "ready")
      .map(([id]) => id);

    await Promise.all(activeIds.map((id) => this.stop(id, false)));
  }

  registerTools(registry: ToolRegistry): void {
    registry.register(this.createStartTool());
    registry.register(this.createLogsTool());
    registry.register(this.createListTool());
    registry.register(this.createStopTool());
  }

  private createStartTool(): AgentTool {
    return {
      name: "bg_start",
      description:
        "Start a long-running process in the background (web server, watcher, local database, mock server) without blocking the agent. Automatically detects listening ports and URLs.",
      parameters: z.object({
        command: z.string().min(1).describe("The shell command to execute in the background."),
        id: z.string().optional().describe("Optional unique identifier for this background process."),
        cwd: z.string().optional().describe("Optional working directory."),
        waitForReadyRegex: z
          .string()
          .optional()
          .describe("Optional regex string to wait for in output before returning (e.g. 'Listening on' or 'Ready in')."),
        readyTimeoutMs: z
          .number()
          .int()
          .positive()
          .default(5000)
          .describe("Maximum milliseconds to wait for waitForReadyRegex."),
      }),
      readOnly: false,
      execute: async (args) => {
        const input = args as BgStartOptions;
        const info = await this.start(input);
        const logs = this.getLogs(info.id, { lines: 10 });

        const urlSection =
          info.listeningUrls.length > 0
            ? `\nDetected URLs:\n${info.listeningUrls.map((u) => `  - ${u}`).join("\n")}`
            : "";

        return [
          `Background process started:`,
          `  ID: ${info.id}`,
          `  PID: ${info.pid}`,
          `  Status: ${info.status}`,
          `  Command: ${info.command}`,
          urlSection,
          `Initial output:\n${logs.formatted}`,
        ].filter(Boolean).join("\n");
      },
    };
  }

  private createLogsTool(): AgentTool {
    return {
      name: "bg_logs",
      description:
        "Retrieve recent stdout and stderr logs from a running or stopped background process.",
      parameters: z.object({
        processId: z.string().min(1).describe("The background process ID."),
        lines: z.number().int().positive().default(50).describe("Number of recent lines to retrieve."),
        filterRegex: z.string().optional().describe("Optional regex filter for log lines."),
        sinceLastRead: z
          .boolean()
          .default(false)
          .describe("If true, only returns lines that arrived since the last bg_logs call."),
      }),
      readOnly: true,
      execute: async (args) => {
        const input = args as { processId: string; lines?: number; filterRegex?: string; sinceLastRead?: boolean };
        const result = this.getLogs(input.processId, input);
        return [
          `[PROCESS LOGS: ${result.processId}] (status: ${result.status}, total lines: ${result.totalLines}, new lines: ${result.newLinesCount})`,
          result.formatted,
        ].join("\n");
      },
    };
  }

  private createListTool(): AgentTool {
    return {
      name: "bg_list",
      description:
        "List all active and historical background processes managed by the agent runtime.",
      parameters: z.object({}),
      readOnly: true,
      execute: async () => {
        const list = this.list();
        if (list.length === 0) {
          return "No background processes currently active or recorded.";
        }

        const now = Date.now();
        const rows = list.map((p) => {
          const uptimeSec = Math.floor((now - p.startTime) / 1000);
          const uptimeStr = uptimeSec > 60 ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s` : `${uptimeSec}s`;
          const urls = p.listeningUrls.length > 0 ? p.listeningUrls.join(", ") : "none";
          return `- [${p.status.toUpperCase()}] ${p.id} (PID ${p.pid}) | uptime: ${uptimeStr} | URLs: ${urls}\n    Command: ${p.command}`;
        });

        return [`Active Background Processes (${list.length}):`, ...rows].join("\n");
      },
    };
  }

  private createStopTool(): AgentTool {
    return {
      name: "bg_stop",
      description: "Stop a running background process gracefully (SIGTERM), falling back to SIGKILL.",
      parameters: z.object({
        processId: z.string().min(1).describe("The background process ID to stop."),
        force: z.boolean().default(false).describe("If true, sends SIGKILL immediately."),
      }),
      readOnly: false,
      execute: async (args) => {
        const input = args as { processId: string; force?: boolean };
        const stopped = await this.stop(input.processId, input.force);
        if (!stopped) {
          return `Process "${input.processId}" was not found or already stopped.`;
        }
        return `Background process "${input.processId}" successfully stopped.`;
      },
    };
  }

  private async streamReader(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let remainder = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        remainder += decoder.decode(value, { stream: true });
        const lines = remainder.split("\n");
        remainder = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim().length > 0) {
            onLine(line);
          }
        }
      }
      if (remainder.trim().length > 0) {
        onLine(remainder);
      }
    } catch {
      // Stream reading ended.
    }
  }

  private detectListeningUrls(line: string, detected: string[]): void {
    const cleanLine = line.trim();

    for (const pattern of URL_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(cleanLine)) !== null) {
        let candidate = match[0].trim();

        if (/^\d{2,5}$/.test(candidate)) {
          candidate = `http://localhost:${candidate}`;
        } else if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})$/i.test(candidate)) {
          const port = /:(\d{2,5})$/.exec(candidate)?.[1];
          candidate = `http://localhost:${port}`;
        } else if (/^(?:listening|ready|running|server)/i.test(candidate)) {
          const subMatch = match[1];
          if (subMatch) {
            candidate = /^\d{2,5}$/.test(subMatch) ? `http://localhost:${subMatch}` : subMatch;
          }
        }

        if (candidate.startsWith("http://0.0.0.0")) {
          candidate = candidate.replace("http://0.0.0.0", "http://localhost");
        }

        if (candidate.startsWith("http") && !detected.includes(candidate)) {
          detected.push(candidate);
        }
      }
    }
  }
}
