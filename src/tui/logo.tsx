import React from "react";
import { Box, Text } from "ink";

import packageJson from "../../package.json";
import { getTheme, type Theme } from "./theme";

export interface OrchivoxLogoProps {
  variant?: "emblem" | "compact";
  theme?: Theme;
}

export function OrchivoxLogo({ variant = "emblem", theme }: OrchivoxLogoProps): React.ReactElement {
  const active = theme ?? getTheme("tokyonight");

  if (variant === "compact") {
    return (
      <Box>
        <Text color={active.border.passive}>(</Text>
        <Text bold color={active.accent}>◎</Text>
        <Text color={active.border.passive}>)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" alignItems="center">
      <Text bold color={active.accent}>          ▄▄███▄▄  ╱●           </Text>
      <Text bold color={active.accent}>        ▄██▀   ▀█╱´█▄           </Text>
      <Text bold color={active.accent}>        ███  ● ╱´ ███           </Text>
      <Text bold color={active.accent}>        ▀██▄ ╱´▄███▀            </Text>
      <Text bold color={active.accent}>         ●╱▀▀███▀▀              </Text>
    </Box>
  );
}

export interface WelcomeBannerProps {
  theme?: Theme;
  repoPath?: string;
  branch?: string;
}

export function WelcomeBanner({ theme, repoPath, branch }: WelcomeBannerProps): React.ReactElement {
  const active = theme ?? getTheme("tokyonight");

  return (
    <Box flexDirection="column" alignItems="center" marginY={1}>
      <OrchivoxLogo variant="emblem" theme={active} />
      <Box marginTop={1}>
        <Text bold color={active.accent}>ORCHIVOX</Text>
        <Text> </Text>
        <Text bold color={active.modes.plan.secondary}>AGENT</Text>
        <Text color={active.muted} dimColor> v{packageJson.version}</Text>
      </Box>
      {repoPath ? (
        <Box marginTop={0}>
          <Text color={active.muted} dimColor>
            {repoPath} {branch && branch !== "unknown" ? `(${branch})` : ""}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text color={active.muted}>
          Type a prompt to begin.
        </Text>
        <Box gap={1} marginTop={0}>
          <Text color={active.accent}>Tab</Text>
          <Text color={active.muted}>Mode</Text>
          <Text color={active.border.passive}>·</Text>
          <Text color={active.accent}>Ctrl+P</Text>
          <Text color={active.muted}>Palette</Text>
          <Text color={active.border.passive}>·</Text>
          <Text color={active.accent}>/models</Text>
          <Text color={active.muted}>Models</Text>
          <Text color={active.border.passive}>·</Text>
          <Text color={active.accent}>/help</Text>
          <Text color={active.muted}>Help</Text>
        </Box>
      </Box>
    </Box>
  );
}
