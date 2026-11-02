import { bootstrap } from "../src/index";
import { formatTurnObservation, observeTurn } from "../src/agent/turn-observation";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('usage: bun run observe:turn "task for the model"');
  process.exit(1);
}

const runtime = await bootstrap({ repoRoot: process.cwd() });
try {
  const model = runtime.router.getModeModel("build");
  const session = runtime.database.createSession({
    title: "turn budget observation",
    mode: "build",
  });
  const observation = await observeTurn({
    orchestrator: runtime.orchestrator,
    profile: "orchivox-main",
    prompt,
    sessionId: session.id,
  });
  console.log(
    `model: ${model ? `${model.provider}/${model.model}` : "(unconfigured)"} · mode: build`,
  );
  console.log(formatTurnObservation(observation));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await runtime.close();
}
