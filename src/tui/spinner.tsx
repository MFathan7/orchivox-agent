import React from "react";
import { Text } from "ink";

import { formatTurnStatus } from "./format";
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

  return (
    <Text>
      <Text color={theme.badge.running} bold>
        {frame}{" "}
      </Text>
      <Text color={theme.text} bold>
        {formatTurnStatus({
          answering,
          elapsedSeconds,
          completedTools,
          runningLabel,
          runningSeconds,
          step,
        })}
      </Text>
      <Text color={theme.muted}> · Esc twice to stop</Text>
    </Text>
  );
}
