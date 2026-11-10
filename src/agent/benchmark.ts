export interface BenchmarkSample {
  agent: "orchivox" | "omp";
  model: string;
  reasoning: string;
  wall_ms: number;
  startup_ms: number;
  first_text_ms?: number;
  tool_calls: number;
  prompt_tokens: number;
  cache_read_tokens: number;
  finish_reason: string;
  verified: boolean;
  error?: string;
  case_id?: string;
  fixture_sha256?: string;
  workers?: number;
  checkpoints?: number;
  checks?: Array<{ name: string; passed: boolean }>;
}

export function summarizeBenchmark(samples: BenchmarkSample[]) {
  const groups = new Map<string, BenchmarkSample[]>();
  for (const sample of samples) {
    const key = JSON.stringify([sample.agent, sample.case_id, sample.model, sample.reasoning, sample.fixture_sha256]);
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  return [...groups.values()].map((runs) => {
    const { agent, case_id, model, reasoning, fixture_sha256 } = runs[0];
    const passed = runs.filter((sample) => sample.verified);
    const sorted = passed.map((sample) => sample.wall_ms).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return { agent, ...(case_id ? { case_id } : {}), model, reasoning, ...(fixture_sha256 ? { fixture_sha256 } : {}), runs: runs.length, verified: passed.length,
      median_wall_ms: sorted.length ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : undefined,
      min_wall_ms: sorted[0], max_wall_ms: sorted.at(-1),
    };
  });
}

export class OmpBenchmarkEvents {
  started_ms?: number;
  first_text_ms?: number;
  tool_calls = 0;
  prompt_tokens = 0;
  cache_read_tokens = 0;
  text = "";
  finish_reason = "unknown";
  model?: string;
  workers = 0;

  record(value: unknown, elapsedMs: number): void {
    if (!value || typeof value !== "object") return;
    const event = value as {
      type?: string;
      toolName?: string;
      args?: { tasks?: unknown[] };
      assistantMessageEvent?: { type?: string; delta?: string };
      message?: { role?: string; model?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }>; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } };
    };
    if (event.type === "agent_start") this.started_ms ??= elapsedMs;
    if (event.type === "tool_execution_start") {
      this.tool_calls += 1;
      this.text = "";
      if (event.toolName === "task") this.workers += event.args?.tasks?.length ?? 1;
    }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      this.first_text_ms ??= elapsedMs;
      this.text += event.assistantMessageEvent.delta ?? "";
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      this.model = message.model ?? this.model;
      if (message.content) this.text = message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
      const usage = message.usage;
      if (usage) {
        this.prompt_tokens += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        this.cache_read_tokens += usage.cacheRead ?? 0;
      }
      this.finish_reason = message.stopReason ?? this.finish_reason;
    }
    if (event.type === "error") this.finish_reason = "error";
  }
}
