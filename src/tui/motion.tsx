import React from "react";
import { Text, useStdout } from "ink";

import { graphemeClusters, displayWidth } from "./text-wrap";
import { useTheme } from "./theme";
import { fallbackFrameClock, type FrameClock } from "./frame-clock";

const MotionContext = React.createContext(true);
const FrameClockContext = React.createContext(fallbackFrameClock);
const noSubscription = () => () => undefined;

export function animationsEnabled(enabled: boolean, tty: boolean, env = process.env): boolean {
  return enabled && tty && env.TERM !== "dumb" && env.NO_COLOR === undefined;
}

export function MotionProvider({ enabled, children, clock = fallbackFrameClock }: { enabled: boolean; children: React.ReactNode; clock?: FrameClock }) {
  const { stdout } = useStdout();
  return <FrameClockContext.Provider value={clock}><MotionContext.Provider value={animationsEnabled(enabled, Boolean(stdout.isTTY))}>{children}</MotionContext.Provider></FrameClockContext.Provider>;
}

export function useMotion(): boolean {
  return React.useContext(MotionContext);
}

export function useAnimationFrame(active: boolean, frames: number, frameMs = 100): number {
  const enabled = useMotion();
  const clock = React.useContext(FrameClockContext);
  const running = active && enabled;
  const snapshot = React.useCallback(() => running ? Math.floor(clock.snapshot() / frameMs) % frames : 0, [clock, frameMs, frames, running]);
  return React.useSyncExternalStore(running ? clock.subscribe : noSubscription, snapshot, snapshot);
}

export function useElapsedSeconds(startedAt?: number): number | undefined {
  const enabled = useMotion();
  const clock = React.useContext(FrameClockContext);
  const snapshot = React.useCallback(() => startedAt === undefined
    ? undefined
    : Math.max(0, Math.floor((Date.now() - startedAt) / 1000)), [startedAt]);
  return React.useSyncExternalStore(enabled && startedAt !== undefined ? clock.subscribe : noSubscription, snapshot, snapshot);
}

export function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const linear = rgb.map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function shimmerColor(base: string, highlight: string, background: string, strength: number): string {
  const amount = Math.max(0, Math.min(1, strength));
  const channels = [1, 3, 5].map((offset) => {
    const a = parseInt(base.slice(offset, offset + 2), 16);
    const b = parseInt(highlight.slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * amount).toString(16).padStart(2, "0");
  });
  const color = `#${channels.join("")}`;
  return contrastRatio(color, background) >= 4.5 ? color : base;
}

export function ActivityText({ text, active = true }: { text: string; active?: boolean }) {
  const theme = useTheme();
  const enabled = useMotion();
  const frame = useAnimationFrame(active, 60, 2000 / 60);
  const width = displayWidth(text);
  const center = (frame / 59) * (width + 8) - 4;
  let column = 0;
  return <Text>{graphemeClusters(text).map((glyph, index) => {
    const distance = Math.abs(column - center);
    column += displayWidth(glyph);
    const strength = active && enabled ? Math.max(0, 1 - distance / 4) : 0;
    return <Text key={index} bold color={shimmerColor(theme.muted, theme.text, theme.background, strength)}>{glyph}</Text>;
  })}</Text>;
}
