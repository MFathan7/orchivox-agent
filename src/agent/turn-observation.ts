import type { AgentProfile, AgentRunRequest } from "../api/server";
import type { Message, StreamEvent, TurnMetrics } from "../types/schema";
import { formatTurnMetrics } from "./turn-metrics";
import type { AgentOrchestrator } from "./orchestrator";

export interface TurnObservation {
  prompt: string;
  metrics: TurnMetrics;
  events: StreamEvent[];
  answer: string;
}

export interface ObserveTurnOptions {
  orchestrator: AgentOrchestrator;
  profile: AgentProfile;
  prompt: string;
  sessionId: string;
  reasoningEffort?: string;
  signal?: AbortSignal;
}

/**
 * Runs one fixed task and records the turn budget. Use it to compare models and
 * reasoning levels before adding a model-specific prompt profile.
 */
export async function observeTurn(options: ObserveTurnOptions): Promise<TurnObservation> {
  const message: Message = {
    id: `observe-${Date.now().toString(36)}`,
    role: "user",
    content: [{ type: "text", text: options.prompt }],
    created_at: Date.now(),
  };
  const request: AgentRunRequest = {
    profile: options.profile,
    messages: [message],
    tools: [],
    tool_choice: { mode: "auto" },
    stop_sequences: [],
    metadata: { session_id: options.sessionId },
    ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
  };
  const events: StreamEvent[] = [];
  let answer = "";
  for await (const event of options.orchestrator.runStream(request, options.signal)) {
    events.push(event);
    if (event.type === "token") answer += event.text;
    else if (event.type === "final_text") answer = event.text;
    else if (event.type === "tool_start") answer = "";
  }
  const metrics = options.orchestrator.getLastTurnMetrics(options.sessionId);
  if (!metrics) {
    throw new Error("The observed turn finished without metrics.");
  }
  return { prompt: options.prompt, metrics, events, answer };
}

export function formatTurnObservation(observation: TurnObservation): string {
  return [`Turn observation: ${observation.prompt}`, "", formatTurnMetrics(observation.metrics)].join(
    "\n",
  );
}
