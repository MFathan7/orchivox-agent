import React from "react";
import { Box, Text, useInput } from "ink";

import type { SubagentWorkerState } from "../agent/subagent";

export interface AgentHubProps {
  workers: SubagentWorkerState[];
  active?: boolean;
  onSteer: (workerId: string, instruction: string) => void;
  onKill: (workerId: string) => void;
  onExit: () => void;
  initialSelected?: number;
}

const STATUS_COLORS: Record<string, string> = {
  queued: "gray",
  preparing: "yellow",
  running: "yellow",
  finalizing: "yellow",
  completed: "green",
  failed: "red",
  aborted: "gray",
  timed_out: "red",
};

export function AgentHub({ workers, active = true, onSteer, onKill, onExit, initialSelected = 0 }: AgentHubProps) {
  const [selected, setSelected] = React.useState(Math.min(initialSelected, Math.max(workers.length - 1, 0)));
  const [steering, setSteering] = React.useState<string | null>(null);
  const selectedIndex = workers.length === 0 ? -1 : Math.min(selected, workers.length - 1);
  const current = selectedIndex >= 0 ? workers[selectedIndex] : undefined;

  useInput(
    (input, key) => {
      if (steering !== null) {
        if (key.return) {
          if (current && steering.trim().length > 0) onSteer(current.id, steering.trim());
          setSteering(null);
          return;
        }
        if (key.escape) {
          setSteering(null);
          return;
        }
        if (key.backspace || key.delete) {
          setSteering((value) => (value ?? "").slice(0, -1));
          return;
        }
        if (!key.ctrl && !key.meta && input.length > 0) {
          setSteering((value) => (value ?? "") + input);
        }
        return;
      }

      if (key.escape) {
        onExit();
        return;
      }
      if (key.upArrow) {
        setSelected((index) => Math.max(0, index - 1));
        return;
      }
      if (key.downArrow) {
        setSelected((index) => Math.min(Math.max(workers.length - 1, 0), index + 1));
        return;
      }
      if (input === "s" && current) {
        setSteering("");
        return;
      }
      if (input === "k" && current) {
        onKill(current.id);
      }
    },
    { isActive: active },
  );

  const transcript = current?.transcript.slice(-10) ?? [];
  const usage = current?.usage;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        [AGENT HUB] arrows: move | s: steer | k: kill | Esc: back
      </Text>
      <Box>
        <Box width="40%" flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text bold>Subagents ({workers.length})</Text>
          {workers.length === 0 ? <Text dimColor>(none running)</Text> : null}
          {workers.map((worker, index) => {
            const color = STATUS_COLORS[worker.status] ?? "gray";
            const marker = index === selectedIndex ? ">" : " ";
            return (
              <Text key={worker.id} color={color} bold={index === selectedIndex}>
                {marker} {worker.id} [{worker.status}]
              </Text>
            );
          })}
        </Box>
        <Box width="60%" flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          {current ? (
            <>
              <Text bold>{current.id}</Text>
              <Text dimColor>task: {current.task.slice(0, 80)}</Text>
              <Text color={STATUS_COLORS[current.status] ?? "gray"}>status: {current.status}</Text>
              <Text>worktree: {current.worktreePath ?? "(none)"}</Text>
              <Text>
                tokens: {usage ? `${usage.prompt_tokens + usage.completion_tokens}` : "0"}
                {usage?.cost_usd !== undefined ? ` ($${usage.cost_usd.toFixed(4)})` : ""}
              </Text>
              <Text bold>live transcript:</Text>
              {transcript.length === 0 ? <Text dimColor>(empty)</Text> : null}
              {transcript.map((line, index) => (
                <Text key={index} dimColor>
                  {line.length > 90 ? `${line.slice(0, 87)}...` : line}
                </Text>
              ))}
            </>
          ) : (
            <Text dimColor>select a subagent to inspect</Text>
          )}
        </Box>
      </Box>
      {steering !== null ? (
        <Text color="yellow">
          Steering {current?.id ?? ""}&gt; {steering}_ (Enter to send, Esc to cancel)
        </Text>
      ) : null}
    </Box>
  );
}
