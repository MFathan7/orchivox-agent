import React from "react";
import { Text } from "ink";

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
  runningDetail?: string;
  runningStartedAt?: number;
  step?: number;
  stepLimit?: number;
  toolLimit?: number;
  timeLimitSeconds?: number;
  contextPercent?: number;
  requestLabel?: string;
  width?: number;
}

export function LiveStatus({
  active,
  answering,
  runningLabel,
  width,
}: LiveStatusProps): React.ReactElement | null {
  if (!active) return null;
  const label = runningLabel || (answering ? "Answering" : "Thinking");
  return <ActivityText text={width === undefined ? label : fitDisplayText(label, width)} active={active} />;
}
