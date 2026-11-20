import React from "react";
import { Box, Text } from "ink";

import { toolDisplay } from "../agent/tool-display";
import type { ChatToolCallView } from "./app";
import { fitSegments, formatElapsed } from "./format";
import type { ActivityIndicator } from "./layout";
import { fitDisplayText, singleLine } from "./text-wrap";
import { useTheme } from "./theme";
import { ActivityText, shimmerColor, useAnimationFrame, useElapsedSeconds, useMotion } from "./motion";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PULSE_FRAMES = [
  { glyph: "·", highlight: 0 },
  { glyph: "◇", highlight: 0.55 },
  { glyph: "✦", highlight: 1 },
  { glyph: "◇", highlight: 0.55 },
];

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

function PulseStatus({ text }: { text: string }): React.ReactElement {
  const theme = useTheme();
  const enabled = useMotion();
  const index = useAnimationFrame(true, PULSE_FRAMES.length, 90);
  const frame = enabled ? PULSE_FRAMES[index] : PULSE_FRAMES[2];
  const color = shimmerColor(theme.muted, theme.accent, theme.background, frame.highlight);
  return <Text color={theme.muted} wrap="truncate">
    <Text color={color} bold>{frame.glyph} </Text>
    {text}
  </Text>;
}

export interface LiveStatusProps {
  agentCounts?: { active: number; failed: number };
  active: boolean;
  answering: boolean;
  startedAt?: number;
  completedTools: number;
  runningLabel?: string;
  runningDetail?: string;
  runningTools?: readonly ChatToolCallView[];
  canInterrupt?: boolean;
  runningStartedAt?: number;
  step?: number;
  stepLimit?: number;
  toolLimit?: number;
  timeLimitSeconds?: number;
  contextPercent?: number;
  requestLabel?: string;
  width?: number;
  indicator?: ActivityIndicator;
}

function activeToolDetail(calls: readonly ChatToolCallView[], label?: string): string {
  if (calls.length === 0) return "";
  if (calls.length > 1) {
    const names = calls.map((call) => singleLine(call.label ?? toolDisplay(call.name).label));
    return [label, names.join(", ")].filter(Boolean).join(" · ");
  }
  const call = calls[0];
  const { progress } = call;
  const counter = progress ? `${progress.progress}${progress.total === undefined ? "" : `/${progress.total}`}` : undefined;
  const target = call.filePath ?? (call.command ? `$ ${call.command}` : call.detail);
  return [label, counter, target, progress?.message].map((part) => singleLine(part ?? "")).filter(Boolean).join(" · ");
}

function WorkStatus({
  title,
  runningLabel,
  runningTools = [],
  startedAt,
  canInterrupt,
  width = 80,
}: {
  title: string;
  runningLabel?: string;
  runningTools?: readonly ChatToolCallView[];
  startedAt?: number;
  canInterrupt?: boolean;
  width?: number;
}) {
  const theme = useTheme();
  const elapsed = useElapsedSeconds(startedAt);
  const heading = fitDisplayText(title, width);
  const parts = [{ key: "heading", text: heading, dropOrder: 100 }];
  if (elapsed !== undefined) parts.push({ key: "time", text: ` · ${formatElapsed(elapsed)}`, dropOrder: 2 });
  if (canInterrupt) parts.push({ key: "interrupt", text: " · Esc twice to stop", dropOrder: 1 });
  const fitted = fitSegments(parts, width);
  const detail = activeToolDetail(runningTools, runningLabel);
  return <Box flexDirection="column" width={width} flexShrink={0}>
    <Text color={theme.muted} wrap="truncate">
      <ActivityText text={heading} />
      {parts.slice(1).filter((part) => fitted.has(part.key)).map((part) => part.text).join("")}
    </Text>
    {detail ? <Text color={theme.muted} wrap="truncate">{fitDisplayText(`  └ ${detail}`, width)}</Text> : null}
  </Box>;
}

export function LiveStatus({
  active,
  answering,
  runningLabel,
  runningDetail,
  runningTools,
  canInterrupt,
  agentCounts,
  startedAt,
  width,
  indicator = "shimmer",
}: LiveStatusProps): React.ReactElement | null {
  const theme = useTheme();
  if (!active) return null;
  const activity = runningLabel || (answering ? "Answering" : "Thinking");
  const showOwner = agentCounts && agentCounts.active + agentCounts.failed > 0;
  if (indicator === "work") {
    const phase = answering && !runningLabel ? "Answering" : "Working";
    return <WorkStatus title={showOwner ? `Main · ${phase}` : phase} startedAt={startedAt}
      runningLabel={runningLabel} runningTools={runningTools} canInterrupt={canInterrupt} width={width} />;
  }
  const label = showOwner ? `Main · ${activity}` : activity;
  if (indicator === "pulse" && (width === undefined || width > 2)) {
    const detail = runningDetail && singleLine(runningDetail);
    const text = detail ? `${label} · ${detail}` : label;
    return <PulseStatus text={width === undefined ? text : fitDisplayText(text, width - 2)} />;
  }
  if (indicator === "spinner" && (width === undefined || width > 2)) {
    return <Text color={theme.muted} wrap="truncate">
      <Spinner active color={theme.accent} />
      {width === undefined ? label : fitDisplayText(label, width - 2)}
    </Text>;
  }
  if (indicator !== "shimmer") {
    return <Text color={theme.badge.running} wrap="truncate">{width === undefined ? label : fitDisplayText(label, width)}</Text>;
  }
  return <ActivityText text={width === undefined ? label : fitDisplayText(label, width)} active={active} />;
}
