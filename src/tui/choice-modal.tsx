import React from "react";
import { Box, Text, useInput } from "ink";

import { getTheme, type Theme } from "./theme";

export interface ChoiceOption {
  id: string;
  label: string;
  description: string;
  current?: boolean;
}

export interface ChoiceModalProps {
  title: string;
  subtitle?: string;
  options: ChoiceOption[];
  initialIndex?: number;
  width?: number;
  theme?: Theme;
  onSelect: (id: string) => void;
  onCancel: () => void;
}

export function ChoiceModal({
  title,
  subtitle,
  options,
  initialIndex = 0,
  width = 100,
  theme = getTheme("tokyonight"),
  onSelect,
  onCancel,
}: ChoiceModalProps): React.ReactElement {
  const [selected, setSelected] = React.useState(() =>
    Math.max(0, Math.min(options.length - 1, initialIndex)),
  );

  const clamped = Math.max(0, Math.min(options.length - 1, selected));

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setSelected((value) => (value > 0 ? value - 1 : Math.max(0, options.length - 1)));
      return;
    }
    if (key.downArrow) {
      setSelected((value) => (value < options.length - 1 ? value + 1 : 0));
      return;
    }
    if (key.return) {
      const option = options[clamped];
      if (option) onSelect(option.id);
    }
  });

  const labelWidth = Math.max(
    6,
    Math.min(
      14,
      options.reduce((max, option) => Math.max(max, option.label.length), 0) + 2,
    ),
  );

  return (
    <Box flexDirection="column" width={Math.max(20, width)} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={theme.text}>{title}</Text>
        <Text color={theme.muted}>Esc close</Text>
      </Box>
      {subtitle ? <Text color={theme.muted}>{subtitle}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {options.length === 0 ? (
          <Text color={theme.muted}>Nothing to choose.</Text>
        ) : (
          options.map((option, index) => {
            const isActive = index === clamped;
            return (
              <Text key={option.id} wrap="truncate">
                <Text color={isActive ? theme.accent : theme.muted}>{isActive ? "❯ " : "  "}</Text>
                <Text bold={isActive} color={theme.text}>{option.label.padEnd(labelWidth)}</Text>
                <Text color={theme.muted}>
                  {option.description}
                  {option.current ? " · current" : ""}
                </Text>
              </Text>
            );
          })
        )}
      </Box>
      <Text color={theme.muted}>Up/Down move · Enter select · Esc close</Text>
    </Box>
  );
}
