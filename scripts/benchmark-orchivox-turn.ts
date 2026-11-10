import { bootstrap } from "../src/index";
import { observeTurn } from "../src/agent/turn-observation";
import { redactSecrets } from "../src/security/secrets";

const input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as {
  repo: string; config: string; mode: "plan" | "build"; prompt: string; reasoning: string; timeout_seconds: number;
};
const startedAt = Date.now();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("Benchmark timed out")), input.timeout_seconds * 1000);
let runtime: Awaited<ReturnType<typeof bootstrap>> | undefined;
try {
  runtime = await bootstrap({ repoRoot: input.repo, configPath: input.config });
  const route = runtime.router.getModeModel(input.mode);
  if (!route) throw new Error(`No model configured for ${input.mode}`);
  runtime.router.setRole("fast", route.provider, route.model);
  runtime.router.setRole("advisor", route.provider, route.model);
  const session = runtime.database.createSession({ title: "workflow benchmark", mode: input.mode });
  const startupMs = Date.now() - startedAt;
  const observed = await observeTurn({ orchestrator: runtime.orchestrator, profile: input.mode === "plan" ? "orchivox-plan" : "orchivox-main",
    prompt: input.prompt, sessionId: session.id, reasoningEffort: input.reasoning, signal: controller.signal });
  console.log(JSON.stringify({ type: "benchmark_result", answer: observed.answer,
    sample: { model: `${route.provider}/${route.model}`, reasoning: observed.metrics.provider_timings?.[0]?.reasoning_effort ?? "none",
      startup_ms: startupMs, first_text_ms: observed.metrics.first_text_ms === undefined ? undefined : startupMs + observed.metrics.first_text_ms,
      tool_calls: observed.metrics.tool_calls, prompt_tokens: observed.metrics.prompt_tokens,
      cache_read_tokens: observed.metrics.provider_timings?.reduce((sum, request) => sum + request.cache_read_tokens, 0) ?? 0,
      finish_reason: observed.metrics.finish_reason ?? "unknown", workers: observed.metrics.workers?.length ?? 0,
      checkpoints: observed.metrics.progress_checkpoints ?? 0,
    },
  }));
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await runtime?.close();
}
