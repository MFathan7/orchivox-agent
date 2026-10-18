import React from "react";
import { Box, Text, useInput } from "ink";

import { OrchivoxLogo } from "./logo";
import { getTheme, type Theme } from "./theme";

export interface WorkspaceTrustPromptProps {
  workspacePath: string;
  onTrust: () => void;
  onExit: () => void;
  theme?: Theme;
}

const OPTIONS = [
  { id: "trust", label: "Yes, I trust this folder" },
  { id: "exit", label: "No, exit" },
];

export function WorkspaceTrustPrompt({
  workspacePath,
  onTrust,
  onExit,
  theme = getTheme("tokyonight"),
}: WorkspaceTrustPromptProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = React.useState(0);

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : OPTIONS.length - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setSelectedIndex((prev) => (prev < OPTIONS.length - 1 ? prev + 1 : 0));
      return;
    }
    if (key.return) {
      if (selectedIndex === 0) {
        onTrust();
      } else {
        onExit();
      }
      return;
    }
    if (key.escape) {
      onExit();
      return;
    }
  });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} borderStyle="round" borderColor={theme.border.active}>
      <Box marginBottom={1} gap={1} alignItems="center">
        <OrchivoxLogo variant="compact" theme={theme} />
        <Text bold color={theme.text}>
          Workspace trust
        </Text>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Text bold color={theme.text}>
          Do you trust the authors of the files in this workspace folder?
        </Text>
        <Box marginTop={1} paddingX={1} borderStyle="single" borderColor={theme.border.passive}>
          <Text color={theme.accent}>{workspacePath}</Text>
        </Box>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Text color={theme.muted}>
          Trusting allows Orchivox to execute tools, run commands, and read files in this directory.
        </Text>
        <Text color={theme.muted}>
          If you do not trust this workspace, Orchivox will exit.
        </Text>
      </Box>

      <Box flexDirection="column" marginY={1}>
        {OPTIONS.map((option, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Box key={option.id} gap={1}>
              <Text bold color={isSelected ? theme.accent : theme.muted}>
                {isSelected ? "❯" : " "}
              </Text>
              <Text bold={isSelected} color={isSelected ? theme.text : theme.muted}>
                {option.label}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted}>
          Up/Down navigate · Enter select · Esc exit
        </Text>
      </Box>
    </Box>
  );
}
