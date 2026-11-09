import React from "react";
import { Text, useStdout } from "ink";

import { graphemeClusters, displayWidth } from "./text-wrap";
import { useTheme } from "./theme";

const MotionContext = React.createContext(true);

export function animationsEnabled(enabled: boolean, tty: boolean, env = process.env): boolean {
  return enabled && tty && env.TERM !== "dumb" && env.NO_COLOR === undefined;
}

export function MotionProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const { stdout } = useStdout();
  return <MotionContext.Provider value={animationsEnabled(enabled, Boolean(stdout.isTTY))}>{children}</MotionContext.Provider>;
}

export function useMotion(): boolean {
  return React.useContext(MotionContext);
}

export function useAnimationFrame(active: boolean, frames: number): number {
  const enabled = useMotion();
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    if (!active || !enabled) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % frames), 100);
    return () => clearInterval(timer);
  }, [active, enabled, frames]);
  return active && enabled ? frame : 0;
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
  const frame = useAnimationFrame(active, 20);
  const width = displayWidth(text);
  const center = (frame / 19) * (width + 8) - 4;
  let column = 0;
  return <Text>{graphemeClusters(text).map((glyph, index) => {
    const distance = Math.abs(column - center);
    column += displayWidth(glyph);
    const strength = active && enabled ? Math.max(0, 1 - distance / 4) : 0;
    return <Text key={index} bold color={shimmerColor(theme.muted, theme.text, theme.background, strength)}>{glyph}</Text>;
  })}</Text>;
}
