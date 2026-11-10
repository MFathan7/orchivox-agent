import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/loader";
import { resolveConfigPaths } from "../src/config/paths";
import { OmpBenchmarkEvents, summarizeBenchmark, type BenchmarkSample } from "../src/agent/benchmark";
import { BenchmarkSuiteSchema, benchmarkChecks, comparableModels, copyBenchmarkFixture, fingerprintWorkspace, fixturePath, workspaceDigest } from "../src/agent/benchmark-workspace";
import { redactSecrets } from "../src/security/secrets";

const usage = "benchmark:agents --suite benchmarks/workflow.json [--agent orchivox|omp|both] [--omp-model provider/model] [--config path] [--secrets path] [--runs 3] [--reasoning low] [--timeout-seconds 120] [--output report.json]";

async function command(argv: string[], cwd: string, timeoutMs = 30_000): Promise<boolean> {
  const child = Bun.spawn(argv, { cwd, stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try { return await child.exited === 0; } finally { clearTimeout(timer); }
}

async function initializeGit(cwd: string): Promise<void> {
  for (const argv of [["git", "init", "-q"], ["git", "add", "."], ["git", "-c", "user.name=Orchivox benchmark", "-c", "user.email=benchmark@example.invalid", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-qm", "Benchmark fixture"]]) {
    if (!await command(argv, cwd)) throw new Error("Could not prepare fixture Git history");
  }
}

export async function runWorkflowBenchmark(args: string[]): Promise<void> {
  const values = new Map<string, string>();
  const allowed = new Set(["--suite", "--agent", "--runs", "--config", "--secrets", "--omp-model", "--reasoning", "--timeout-seconds", "--output"]);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]) || !args[index + 1]) throw new Error(usage);
    values.set(args[index], args[index + 1]);
  }
  const suitePath = resolve(values.get("--suite")!);
  const suite = BenchmarkSuiteSchema.parse(JSON.parse(await readFile(suitePath, "utf8")));
  const fixture = fixturePath(suitePath, suite.fixture);
  const selected = values.get("--agent") ?? "both";
  const runs = Number(values.get("--runs") ?? 3);
  const timeoutSeconds = Number(values.get("--timeout-seconds") ?? 120);
  const reasoning = values.get("--reasoning") ?? "low";
  const ompModel = values.get("--omp-model");
  if (!["orchivox", "omp", "both"].includes(selected) || !Number.isInteger(runs) || runs < 1 || runs > 10
    || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600
    || !["none", "low", "medium", "high", "max"].includes(reasoning)) throw new Error(usage);
  if (selected !== "orchivox" && !ompModel?.includes("/")) throw new Error("An exact --omp-model provider/model is required");
  const directory = await mkdtemp(join(tmpdir(), "orchivox-workflow-benchmark-"));
  const samples: BenchmarkSample[] = [];
  try {
    const baselineDigest = workspaceDigest(await fingerprintWorkspace(fixture));
    const configPath = join(directory, "config.yaml");
    if (selected !== "omp") {
      const paths = await resolveConfigPaths({ configFlag: values.get("--config"), secretsFlag: values.get("--secrets") });
      const config = await loadConfig(paths.configPath, process.env, { secretsPath: paths.secretsPath, fallbackSecretsPaths: paths.fallbackSecretsPaths });
      config.lsp.servers = {};
      config.mcp.servers = {};
      await writeFile(configPath, stringify(config), { mode: 0o600 });
    }
    for (const task of suite.cases) {
      for (let run = 0; run < runs; run += 1) {
        const agents: BenchmarkSample["agent"][] = selected === "both" ? (run % 2 === 0 ? ["orchivox", "omp"] : ["omp", "orchivox"]) : [selected as BenchmarkSample["agent"]];
        for (const agent of agents) {
          const workspace = join(directory, `${task.id}-${run}-${agent}`);
          const before = await copyBenchmarkFixture(fixture, workspace);
          if (workspaceDigest(before) !== baselineDigest) throw new Error("The source fixture changed during the benchmark");
          await initializeGit(workspace);
          const sample: BenchmarkSample = { agent, case_id: task.id, fixture_sha256: baselineDigest, model: agent === "omp" ? ompModel! : "unconfigured",
            reasoning, wall_ms: 0, startup_ms: 0, tool_calls: 0, prompt_tokens: 0, cache_read_tokens: 0, finish_reason: "error", verified: false };
          let answer = "";
          const startedAt = Date.now();
          try {
            const argv = agent === "orchivox" ? [process.execPath, fileURLToPath(new URL("./benchmark-orchivox-turn.ts", import.meta.url))]
              : ["omp", "--print", "--mode", "json", "--no-session", "--no-lsp", "--no-pty", "--no-title", "--model", ompModel!, "--smol", ompModel!, "--slow", ompModel!,
                "--thinking", reasoning === "none" ? "off" : reasoning, "--tools", task.mode === "plan" ? "read,grep,glob,task" : "read,grep,glob,edit,write,bash,task", task.prompt];
            const child = Bun.spawn(argv, { cwd: workspace, stdout: "pipe", stderr: "pipe", stdin: "pipe",
              env: { ...process.env, ORCHIVOX_STATE_HOME: join(directory, "state") } });
            if (agent === "orchivox") child.stdin.write(JSON.stringify({ repo: workspace, config: configPath, mode: task.mode, prompt: task.prompt, reasoning, timeout_seconds: timeoutSeconds }));
            child.stdin.end();
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; child.kill(); }, (timeoutSeconds + (agent === "orchivox" ? 2 : 0)) * 1000);
            const errors = new Response(child.stderr).text();
            const ompEvents = new OmpBenchmarkEvents();
            try {
              const decoder = new TextDecoder();
              let pending = "";
              const record = (line: string): void => {
                if (!line.trim()) return;
                let event: { type?: string; sample?: Partial<BenchmarkSample>; answer?: string };
                try { event = JSON.parse(line); } catch { return; }
                if (agent === "omp") ompEvents.record(event, Date.now() - startedAt);
                else if (event.type === "benchmark_result") { Object.assign(sample, event.sample); answer = event.answer ?? ""; }
              };
              for await (const bytes of child.stdout) {
                pending += decoder.decode(bytes, { stream: true });
                if (pending.length > 4_000_000) throw new Error("Benchmark event exceeded 4 MB");
                const lines = pending.split("\n");
                pending = lines.pop() ?? "";
                for (const line of lines) record(line);
              }
              record(pending + decoder.decode());
              const code = await child.exited;
              if (agent === "omp") {
                Object.assign(sample, { model: ompEvents.model ? `${ompModel!.slice(0, ompModel!.indexOf("/"))}/${ompEvents.model}` : ompModel!, startup_ms: ompEvents.started_ms ?? 0,
                  first_text_ms: ompEvents.first_text_ms, tool_calls: ompEvents.tool_calls, prompt_tokens: ompEvents.prompt_tokens,
                  cache_read_tokens: ompEvents.cache_read_tokens, finish_reason: ompEvents.finish_reason, workers: ompEvents.workers });
                answer = ompEvents.text;
              }
              if (timedOut || code !== 0) {
                sample.finish_reason = timedOut ? "timeout" : "error";
                sample.error = timedOut ? "Benchmark time limit reached." : `Agent process exited with code ${code}; no successful turn was recorded.`;
              }
              await errors;
            } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
          } catch (error) {
            sample.finish_reason = "error";
            sample.error = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1000);
          }
          sample.wall_ms = Date.now() - startedAt;
          try {
            const after = await fingerprintWorkspace(workspace);
            const verifierPassed = task.verify?.length ? await command(task.verify, workspace) : undefined;
            sample.checks = benchmarkChecks({ task, answer, finishReason: sample.finish_reason, before, after, verifierPassed });
          } catch (error) {
            sample.error = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1000);
            sample.checks = [{ name: "workspace acceptance", passed: false }];
          }
          sample.verified = sample.checks.every((check) => check.passed);
          samples.push(sample);
          console.error(`${task.id} ${agent} ${run + 1}/${runs}: ${sample.finish_reason}, ${sample.wall_ms}ms, ${sample.verified ? "verified" : "failed acceptance"}`);
        }
      }
    }
    const comparisons = suite.cases.map((task) => {
      const group = samples.filter((sample) => sample.case_id === task.id);
      return { case_id: task.id, both_agents: new Set(group.map((sample) => sample.agent)).size === 2, model_reasoning_fixture_match: comparableModels(group),
        prompt_sha256: createHash("sha256").update(task.prompt).digest("hex") };
    });
    const report = { created_at: new Date().toISOString(), fixture_sha256: baselineDigest, comparisons,
      conditions: "Fresh conversations and identical fixture copies per sample; alternating agent order. Worker role defaults use the selected main route; explicit model overrides remain possible. Orchivox reasoning is recorded from the request; OMP reasoning is the CLI selection. Verify that provider endpoints match before drawing latency conclusions. Native prompts and tool catalogs differ. External acceptance checks run after the timed agent turn. No prompts, answers, credentials, or source files are retained in this report.",
      summary: summarizeBenchmark(samples), samples };
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (values.has("--output")) await writeFile(resolve(values.get("--output")!), output);
    console.log(output);
    if (samples.some((sample) => !sample.verified) || comparisons.some((entry) => !entry.model_reasoning_fixture_match)) process.exitCode = 1;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
