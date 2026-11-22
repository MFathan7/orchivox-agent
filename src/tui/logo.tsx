import React from "react";
import { Box, Text } from "ink";

import packageJson from "../../package.json";
import { ORCHIVOX_BRAND_PALETTES, useActiveTheme, type Theme } from "./theme";
import { COMPACT_LOGO_TEXT, INSTALLATION_LOGO_WIDTH, INSTALLATION_ORBIT_FRAMES, ORBIT_EMBLEM, SMALL_ORBIT_EMBLEM, installationLogo } from "./logo-art";
import { truncateText } from "./format";
import { useAnimationFrame, useMotion } from "./motion";

export { COMPACT_LOGO_TEXT } from "./logo-art";

export function logoPalette(theme: Theme): Record<string, string> {
  return ORCHIVOX_BRAND_PALETTES[theme.appearance];
}

export interface OrchivoxLogoProps {
  variant?: "emblem" | "compact";
  theme?: Theme;
  small?: boolean;
}

export function OrchivoxLogo({ variant = "emblem", theme, small = false }: OrchivoxLogoProps): React.ReactElement {
  const active = useActiveTheme(theme);
  const palette = logoPalette(active);
  if (variant === "compact") {
    return (
      <Text><Text color={palette.V}>{COMPACT_LOGO_TEXT[0]}</Text><Text bold color={palette.C}>{COMPACT_LOGO_TEXT[1]}</Text><Text color={palette.M}>{COMPACT_LOGO_TEXT[2]}</Text></Text>
    );
  }
  return <LogoEmblem emblem={small ? SMALL_ORBIT_EMBLEM : ORBIT_EMBLEM} palette={palette} />;
}

export function InstallationLogo({ theme }: { theme: Theme }): React.ReactElement {
  const animated = useMotion();
  const frame = useAnimationFrame(animated, INSTALLATION_ORBIT_FRAMES, 85);
  return <Box width={INSTALLATION_LOGO_WIDTH} flexShrink={0}>
    <LogoEmblem emblem={installationLogo(animated ? frame : undefined)} palette={logoPalette(theme)} />
  </Box>;
}

function LogoEmblem({ emblem, palette }: {
  emblem: ReadonlyArray<readonly [string, string]>;
  palette: Record<string, string>;
}): React.ReactElement {
  return (
    <Box flexDirection="column" alignItems="center">
      {emblem.map(([glyphs, tones], row) => {
        const runs: Array<{ text: string; color?: string }> = [];
        for (let column = 0; column < glyphs.length; column++) {
          const color = palette[tones[column]];
          const previous = runs.at(-1);
          if (previous && previous.color === color) previous.text += glyphs[column];
          else runs.push({ text: glyphs[column], color });
        }
        return <Text key={row} wrap="truncate">{runs.map((run, index) => <Text key={index} color={run.color}>{run.text}</Text>)}</Text>;
      })}
    </Box>
  );
}

export interface WelcomeBannerProps {
  theme?: Theme;
  repoPath?: string;
  branch?: string;
  width?: number;
  height?: number;
}

export function WelcomeBanner({ theme, repoPath, branch, width = 100, height = 18 }: WelcomeBannerProps): React.ReactElement {
  const active = useActiveTheme(theme);
  const palette = logoPalette(active);

  return (
    <Box flexDirection="column" alignItems="center" marginTop={1}>
      <OrchivoxLogo variant="emblem" theme={active} small={height < 18} />
      <Box marginTop={1}>
        <Text bold color={active.text}>ORCHIVO<Text color={palette.C}>X</Text></Text>
        <Text> </Text>
        <Text bold color={active.muted}>AGENT</Text>
        <Text color={active.muted}> v{packageJson.version}</Text>
      </Box>
      {repoPath ? (
        <Box marginTop={0}>
          <Text color={active.muted}>
            {truncateText(`${repoPath}${branch && branch !== "unknown" ? ` (${branch})` : ""}`, Math.max(1, width - 4))}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text color={active.muted}>
          Type a prompt to begin.
        </Text>
        <Box gap={1} marginTop={0}>
          <Text color={active.accent}>Shift+Tab</Text>
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
