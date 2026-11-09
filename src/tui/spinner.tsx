import React from "react";
import { Text } from "ink";

import { formatTurnStatus } from "./format";
import { fitDisplayText } from "./text-wrap";
import { useTheme } from "./theme";
import { ActivityText, useAnimationFrame, useMotion } from "./motion";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function useSpinner(active: boolean): string {
  const frame = useAnimationFrame(active, SPINNER_FRAMES.length);
  const enabled = useMotion();
  return active && enabled ? SPINNER_FRAMES[frame] : "●";
}

/** Animation ticks stay inside the indicator rather than re-rendering the transcript. */
export function Spinner({
  active,
  color,
  bold = true,
}: {
  active: boolean;
  color?: string;
  bold?: boolean;
}): React.ReactElement {
  const frame = useSpinner(active);
  return (
    <Text color={color} bold={bold}>
      {frame}{" "}
    </Text>
  );
}

export interface LiveStatusProps {
  agentCounts?: { active: number; failed: number };
  active: boolean;
  answering: boolean;
  startedAt?: number;
  completedTools: number;
  runningLabel?: string;
  runningStartedAt?: number;
  step?: number;
  stepLimit?: number;
  toolLimit?: number;
  timeLimitSeconds?: number;
  contextPercent?: number;
  requestLabel?: string;
  width?: number;
}

/** The clock updates independently of the transcript and animated label. */
export function LiveStatus({
  active,
  answering,
  startedAt,
  completedTools,
  runningLabel,
  runningStartedAt,
  step,
  stepLimit,
  toolLimit,
  timeLimitSeconds,
  contextPercent,
  requestLabel,
  width,
  agentCounts,
}: LiveStatusProps): React.ReactElement | null {
  const theme = useTheme();
  const [, refresh] = React.useState(0);

  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => refresh((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) return null;

  const elapsedSeconds = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  const runningSeconds = runningStartedAt
    ? Math.max(0, Math.floor((Date.now() - runningStartedAt) / 1000))
    : 0;
  const showHint = width === undefined || width >= 120;
  const agents = agentCounts
    ? width !== undefined && width < 60
      ? ` · agents ${agentCounts.active} · failed ${agentCounts.failed}`
      : ` · agents ${agentCounts.active} active · ${agentCounts.failed} failed`
    : "";
  const hint = `${agents}${showHint ? " · Esc twice to stop" : ""}`;
  const available = width !== undefined ? Math.max(1, width - hint.length) : undefined;
  const label = runningLabel || (answering ? "Answering" : "Thinking");
  const status = formatTurnStatus({
    answering,
    elapsedSeconds,
    completedTools,
    runningLabel,
    runningSeconds,
    step,
    stepLimit,
    toolLimit,
    timeLimitSeconds,
    contextPercent,
    requestLabel,
    width: available,
    activityFirst: true,
  });
  const display = available !== undefined ? fitDisplayText(status, available) : status;

  return (
    <Text>
      <ActivityText text={display.slice(0, Math.min(label.length, display.length))} active={active} />
      <Text color={theme.muted}>{display.slice(Math.min(label.length, display.length))}</Text>
      {hint ? <Text color={theme.muted}>{hint}</Text> : null}
    </Text>
  );
}
