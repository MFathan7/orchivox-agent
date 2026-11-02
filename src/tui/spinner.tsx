import React from "react";
import { Text } from "ink";

import { formatTurnStatus } from "./format";
import { fitDisplayText } from "./text-wrap";
import { useTheme } from "./theme";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function useSpinner(active: boolean): string {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    if (!active) {
      setFrame(0);
      return;
    }
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length), 110);
    return () => clearInterval(timer);
  }, [active]);
  return SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
}

/**
 * The spinner owns its timer so it never forces the app or transcript to
 * re-render. It renders one glyph plus the trailing space used by the status
 * row and tool rows.
 */
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

/**
 * The live turn status. The elapsed clock and spinner update inside this small
 * component, not in OrchivoxApp, so a long turn cannot re-render the transcript
 * just to animate the status line.
 */
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
}: LiveStatusProps): React.ReactElement | null {
  const theme = useTheme();
  const frame = useSpinner(active);
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
  const hint = showHint ? " · Esc twice to stop" : "";
  const available = width !== undefined ? Math.max(8, width - 2 - hint.length) : undefined;
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
  });
  const display = available !== undefined ? fitDisplayText(status, available) : status;

  return (
    <Text>
      <Text color={theme.badge.running} bold>
        {frame}{" "}
      </Text>
      <Text color={theme.text} bold>
        {display}
      </Text>
      {hint ? <Text color={theme.muted}>{hint}</Text> : null}
    </Text>
  );
}
