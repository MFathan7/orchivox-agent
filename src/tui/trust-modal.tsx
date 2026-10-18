import React from "react";
import { Box, Text, useInput } from "ink";

import { OrchivoxLogo } from "./logo";

export interface WorkspaceTrustPromptProps {
  workspacePath: string;
  onTrust: () => void;
  onExit: () => void;
}

const OPTIONS = [
  { id: "trust", label: "Yes, I trust this folder" },
  { id: "exit", label: "No, exit" },
];

export function WorkspaceTrustPrompt({
  workspacePath,
  onTrust,
  onExit,
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
    <Box flexDirection="column" paddingX={2} paddingY={1} borderStyle="round" borderColor="#38bdf8">
      <Box marginBottom={1} gap={1} alignItems="center">
        <OrchivoxLogo variant="compact" />
        <Text bold color="#38bdf8">
          Workspace Trust Verification
        </Text>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Text bold color="white">
          Do you trust the authors of the files in this workspace folder?
        </Text>
        <Box marginTop={1} paddingX={1} borderStyle="single" borderColor="gray">
          <Text color="#38bdf8">{workspacePath}</Text>
        </Box>
      </Box>

      <Box marginBottom={1} flexDirection="column">
        <Text color="gray">
          Trusting allows Orchivox to execute tools, run commands, and read files in this directory.
        </Text>
        <Text color="gray">
          If you do not trust this workspace, Orchivox will safely exit.
        </Text>
      </Box>

      <Box flexDirection="column" marginY={1}>
        {OPTIONS.map((option, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Box key={option.id} gap={1}>
              <Text bold color={isSelected ? "#38bdf8" : "gray"}>
                {isSelected ? "❯" : " "}
              </Text>
              <Text
                bold={isSelected}
                color={isSelected ? "cyan" : "gray"}
              >
                {option.label}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor color="gray">
          Use ↑ / ↓ to navigate · Enter to select · Esc to exit
        </Text>
      </Box>
    </Box>
  );
}
