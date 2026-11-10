import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { bootstrap } from "../src/index";
import { observeTurn } from "../src/agent/turn-observation";
import { OmpBenchmarkEvents, summarizeBenchmark, type BenchmarkSample } from "../src/agent/benchmark";
import { redactSecrets } from "../src/security/secrets";

const help = 'usage: bun run benchmark:agents --prompt "read-only task" [--agent orchivox|omp|both] [--runs 3] [--config path] [--secrets path] [--omp-model provider/model] [--reasoning low] [--expect-text literal] [--repo path] [--output report.json] [--timeout-seconds 120]';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { console.log(`${help}\nWorkflow suite: bun run benchmark:agents --suite benchmarks/workflow.json --agent both --omp-model provider/model`); return; }
  if (args.includes("--suite")) {
    const { runWorkflowBenchmark } = await import("./benchmark-workflow");
    await runWorkflowBenchmark(args);
    return;
  }
  const values = new Map<string, string>();
  const allowed = new Set(["--prompt", "--agent", "--runs", "--config", "--secrets", "--omp-model", "--reasoning", "--expect-text", "--repo", "--output", "--timeout-seconds"]);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]) || !args[index + 1]) throw new Error(help);
    values.set(args[index], args[index + 1]);
  }
  const prompt = values.get("--prompt");
  const agent = values.get("--agent") ?? "orchivox";
  const runs = Number(values.get("--runs") ?? 3);
  const timeoutSeconds = Number(values.get("--timeout-seconds") ?? 120);
  const reasoning = values.get("--reasoning") ?? "low";
  const repo = resolve(values.get("--repo") ?? process.cwd());
  const expected = values.get("--expect-text");
  const ompModel = values.get("--omp-model");
  if (!prompt || !["orchivox", "omp", "both"].includes(agent) || !Number.isInteger(runs) || runs < 1 || runs > 10 || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) throw new Error(help);
  if (agent !== "orchivox" && (!ompModel || !ompModel.includes("/"))) throw new Error("OMP requires --omp-model with an exact provider/model; no model fallback is selected by this runner.");
  const samples: BenchmarkSample[] = [];
  const selection = agent === "both" ? ["orchivox", "omp"] as const : [agent] as Array<"orchivox" | "omp">;
  for (let index = 0; index < runs; index += 1) {
    for (const current of selection) {
      const startedAt = Date.now();
      const sample: BenchmarkSample = { agent: current, model: current === "omp" ? ompModel! : "unconfigured", reasoning, wall_ms: 0, startup_ms: 0, tool_calls: 0, prompt_tokens: 0, cache_read_tokens: 0, finish_reason: "error", verified: false };
      let answer = "";
      try {
        if (current === "orchivox") {
          const runtime = await bootstrap({ repoRoot: repo, configPath: values.get("--config"), secretsPath: values.get("--secrets") });
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error("Benchmark timeout")), timeoutSeconds * 1000);
          const session = runtime.database.createSession({ title: "read-only latency benchmark", mode: "plan" });
          try {
            const route = runtime.router.getModeModel("plan");
            sample.model = route ? `${route.provider}/${route.model}` : "unconfigured";
            sample.startup_ms = Date.now() - startedAt;
            const observed = await observeTurn({ orchestrator: runtime.orchestrator, profile: "orchivox-plan", prompt, sessionId: session.id, reasoningEffort: reasoning, signal: controller.signal });
            sample.first_text_ms = observed.metrics.first_text_ms === undefined ? undefined : sample.startup_ms + observed.metrics.first_text_ms;
            sample.tool_calls = observed.metrics.tool_calls;
            sample.prompt_tokens = observed.metrics.prompt_tokens;
            sample.cache_read_tokens = observed.metrics.provider_timings?.reduce((sum, entry) => sum + entry.cache_read_tokens, 0) ?? 0;
            sample.finish_reason = observed.metrics.finish_reason ?? "unknown";
            answer = observed.answer;
            const failure = observed.events.find((event) => event.type === "error");
            if (failure?.type === "error") sample.error = redactSecrets(failure.message).slice(0, 1000);
          } finally {
            clearTimeout(timer);
            await runtime.close();
          }
        } else {
          const events = new OmpBenchmarkEvents();
          const child = Bun.spawn(["omp", "--print", "--mode", "json", "--no-session", "--no-lsp", "--no-pty", "--model", ompModel!, "--thinking", reasoning === "none" ? "off" : reasoning,
            "--tools", "read,grep,glob", "--append-system-prompt", "This is a read-only benchmark. Inspect existing files and answer the request. Do not change files or delegate work.", prompt], { cwd: repo, stdout: "pipe", stderr: "pipe" });
          let timedOut = false;
          const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutSeconds * 1000);
          const stderr = new Response(child.stderr).text();
          try {
            const decoder = new TextDecoder();
            let pending = "";
            for await (const bytes of child.stdout) {
              pending += decoder.decode(bytes, { stream: true });
              if (pending.length > 4_000_000) { child.kill(); throw new Error("OMP emitted an oversized event"); }
              const lines = pending.split("\n");
              pending = lines.pop() ?? "";
              for (const line of lines) {
                if (!line.trim()) continue;
                try { events.record(JSON.parse(line), Date.now() - startedAt); } catch { /* CLI diagnostics are not JSON events. */ }
              }
            }
            const code = await child.exited;
            sample.startup_ms = events.started_ms ?? 0;
            sample.first_text_ms = events.first_text_ms;
            sample.tool_calls = events.tool_calls;
            sample.prompt_tokens = events.prompt_tokens;
            sample.cache_read_tokens = events.cache_read_tokens;
            sample.finish_reason = timedOut ? "timeout" : code === 0 ? events.finish_reason : "error";
            answer = events.text;
            if (code !== 0) sample.error = redactSecrets(await stderr).slice(0, 1000);
          } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
        }
        sample.verified = sample.finish_reason === "stop" && answer.trim().length > 0 && (!expected || answer.includes(expected));
      } catch (error) {
        sample.error = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1000);
      }
      sample.wall_ms = Date.now() - startedAt;
      samples.push(sample);
      console.error(`${current} run ${index + 1}/${runs}: ${sample.finish_reason}, ${sample.wall_ms}ms, ${sample.verified ? "verified" : "not verified"}`);
    }
  }
  const report = { created_at: new Date().toISOString(), repo, prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
    validation: expected ? "literal answer check" : "nonempty answer and stop; quality has not been reviewed",
    timing: "Wall and first-text times include startup. Tool catalogs and system prompts differ; verify equivalent routes and answer quality before comparing.",
    summary: summarizeBenchmark(samples), samples };
  const json = JSON.stringify(report, null, 2);
  if (values.has("--output")) await Bun.write(resolve(values.get("--output")!), `${json}\n`);
  console.log(json);
  if (samples.some((sample) => !sample.verified)) process.exitCode = 1;
}

await main().catch((error) => { console.error(redactSecrets(error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
