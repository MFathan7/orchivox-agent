import React from "react";
import { Box, Text } from "ink";

import type { Theme } from "./theme";

export interface OrchivoxLogoProps {
  variant?: "emblem" | "compact";
  theme?: Theme;
}

export function OrchivoxLogo({ variant = "emblem" }: OrchivoxLogoProps): React.ReactElement {
  if (variant === "compact") {
    return (
      <Box>
        <Text color="#38bdf8">(</Text>
        <Text bold color="#a855f7">◎</Text>
        <Text color="#2dd4bf">)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" alignItems="center">
      <Box>
        <Text color="#38bdf8">        ╭───── </Text>
        <Text bold color="#38bdf8">○</Text>
        <Text color="#2dd4bf"> ─────╮</Text>
      </Box>
      <Box>
        <Text color="#38bdf8">    ╭──╯   </Text>
        <Text color="#06b6d4">◢</Text>
        <Text bold color="#38bdf8">██████</Text>
        <Text color="#a855f7">◣</Text>
        <Text color="#2dd4bf">   ╰──╮</Text>
      </Box>
      <Box>
        <Text bold color="#38bdf8">  ○─╯   </Text>
        <Text color="#06b6d4">◢</Text>
        <Text bold color="#38bdf8">██◤</Text>
        <Text color="#a855f7">    </Text>
        <Text bold color="#a855f7">◥██</Text>
        <Text color="#2dd4bf">◣</Text>
        <Text bold color="#2dd4bf">   ╰─●</Text>
      </Box>
      <Box>
        <Text color="#38bdf8"> │     </Text>
        <Text bold color="#06b6d4">██◤</Text>
        <Text color="#a855f7">   </Text>
        <Text bold color="#c084fc">◉</Text>
        <Text color="#a855f7">   </Text>
        <Text bold color="#2dd4bf">◥██</Text>
        <Text color="#2dd4bf">     │</Text>
      </Box>
      <Box>
        <Text bold color="#a855f7">  ●─╮   </Text>
        <Text color="#a855f7">◥</Text>
        <Text bold color="#a855f7">██◣</Text>
        <Text color="#2dd4bf">    </Text>
        <Text bold color="#2dd4bf">◢██</Text>
        <Text color="#10b981">◤</Text>
        <Text bold color="#38bdf8">   ╭─○</Text>
      </Box>
      <Box>
        <Text color="#a855f7">    ╰──╮   </Text>
        <Text color="#a855f7">◥</Text>
        <Text bold color="#2dd4bf">██████</Text>
        <Text color="#10b981">◤</Text>
        <Text color="#38bdf8">   ╭──╯</Text>
      </Box>
      <Box>
        <Text color="#a855f7">        ╰───── </Text>
        <Text bold color="#10b981">○</Text>
        <Text color="#38bdf8"> ─────╯</Text>
      </Box>
    </Box>
  );
}

export interface WelcomeBannerProps {
  theme?: Theme;
}

export function WelcomeBanner({ theme }: WelcomeBannerProps): React.ReactElement {
  const accentColor = theme?.accent ?? "#38bdf8";
  const mutedColor = theme?.muted ?? "gray";

  return (
    <Box flexDirection="column" alignItems="center" marginY={1}>
      <OrchivoxLogo variant="emblem" theme={theme} />
      <Box marginTop={1}>
        <Text bold color={accentColor}>ORCHIVOX</Text>
        <Text> </Text>
        <Text bold color="#a855f7">AGENT</Text>
      </Box>
      <Text color={mutedColor} dimColor>
        Personal AI coding agent runtime v0.1.0
      </Text>
      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text color={mutedColor}>
          Type a message to start collaborating, or use shortcut keys:
        </Text>
        <Box gap={1} marginTop={0}>
          <Text color={accentColor}>Tab</Text>
          <Text color={mutedColor}>Mode</Text>
          <Text color={mutedColor}>·</Text>
          <Text color={accentColor}>Ctrl+P</Text>
          <Text color={mutedColor}>Palette</Text>
          <Text color={mutedColor}>·</Text>
          <Text color={accentColor}>Ctrl+S</Text>
          <Text color={mutedColor}>Sessions</Text>
          <Text color={mutedColor}>·</Text>
          <Text color={accentColor}>Alt+A</Text>
          <Text color={mutedColor}>Hub</Text>
          <Text color={mutedColor}>·</Text>
          <Text color={accentColor}>/</Text>
          <Text color={mutedColor}>Commands</Text>
        </Box>
      </Box>
    </Box>
  );
}
