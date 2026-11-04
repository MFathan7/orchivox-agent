import React from "react";
import { Box, Text, useInput } from "ink";

import type { ApprovalPreset } from "../config/loader";
import { isMouseSequence } from "./mouse";
import { useActiveTheme, type Theme } from "./theme";

export type SettingsMode = "plan" | "build" | "ultrawork";

export interface SettingsModalProps {
  preset: ApprovalPreset;
  steps: Record<SettingsMode, number>;
  configPath: string;
  configSource: string;
  width?: number;
  theme?: Theme;
  onPresetChange: (preset: ApprovalPreset) => void;
  onStepsChange: (mode: SettingsMode, steps: number) => void;
  onClose: () => void;
}

const PRESETS: ApprovalPreset[] = ["safer", "env-only", "permissive", "custom"];
const STEP_VALUES = [0, 10, 20, 40, 80, 160];
const MODES: SettingsMode[] = ["plan", "build", "ultrawork"];

const PRESET_LABELS: Record<ApprovalPreset, string> = {
  safer: "Safer Build",
  "env-only": "Env-only",
  permissive: "Permissive",
  custom: "Custom",
};

const PRESET_DESCRIPTIONS: Record<ApprovalPreset, string> = {
  safer: "Ask for credentials, destructive files, database CLIs, and execute.",
  "env-only": "Ask only for .env reads; everything else follows explicit rules.",
  permissive: "No default approval rules. Use only explicit deny rules.",
  custom: "Use only the permissions list from this config.",
};

interface Row {
  id: "preset" | SettingsMode | "config";
  label: string;
  value: string;
  detail?: string;
  editable: boolean;
}

function nextStep(current: number, direction: 1 | -1): number {
  const index = STEP_VALUES.indexOf(current);
  if (index === -1) {
    const next = STEP_VALUES.find((value) => value > current);
    return next ?? STEP_VALUES[STEP_VALUES.length - 1] ?? 0;
  }
  const nextIndex = (index + direction + STEP_VALUES.length) % STEP_VALUES.length;
  return STEP_VALUES[nextIndex] ?? 0;
}

function nextPreset(current: ApprovalPreset, direction: 1 | -1): ApprovalPreset {
  const index = Math.max(0, PRESETS.indexOf(current));
  return PRESETS[(index + direction + PRESETS.length) % PRESETS.length] ?? "safer";
}

export function SettingsModal(props: SettingsModalProps): React.ReactElement {
  const {
    preset,
    steps,
    configPath,
    configSource,
    width = 100,
    theme: themeProp,
    onPresetChange,
    onStepsChange,
    onClose,
  } = props;
  const theme = useActiveTheme(themeProp);
  const [selected, setSelected] = React.useState(0);
  const rows: Row[] = [
    {
      id: "preset",
      label: "Approval preset",
      value: PRESET_LABELS[preset],
      detail: PRESET_DESCRIPTIONS[preset],
      editable: true,
    },
    ...MODES.map((mode) => ({
      id: mode,
      label: `${mode[0]?.toUpperCase()}${mode.slice(1)} steps`,
      value: steps[mode] === 0 ? "unlimited" : String(steps[mode]),
      detail: steps[mode] === 0 ? "0 means no step limit" : "model steps per turn",
      editable: true,
    })),
    {
      id: "config",
      label: "Config",
      value: configPath,
      detail: configSource,
      editable: false,
    },
  ];
  const clamped = Math.max(0, Math.min(selected, rows.length - 1));

  const change = (direction: 1 | -1): void => {
    const row = rows[clamped];
    if (!row?.editable) return;
    if (row.id === "preset") {
      onPresetChange(nextPreset(preset, direction));
      return;
    }
    if (row.id === "config") return;
    onStepsChange(row.id, nextStep(steps[row.id], direction));
  };

  useInput((input, key) => {
    if (isMouseSequence(input)) return;
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelected((value) => (value > 0 ? value - 1 : rows.length - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((value) => (value < rows.length - 1 ? value + 1 : 0));
      return;
    }
    if (key.return || key.rightArrow || input === "l") {
      change(1);
      return;
    }
    if (key.leftArrow || input === "h") {
      change(-1);
    }
  });

  const contentWidth = Math.max(24, width - 2);
  return (
    <Box flexDirection="column" width={Math.max(24, width)} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={theme.text}>
          Settings
        </Text>
        <Text color={theme.muted}>Esc close</Text>
      </Box>
      <Text color={theme.muted}>Safety and turn limits</Text>

      <Box flexDirection="column">
        {rows.map((row, index) => {
          const isSelected = index === clamped;
          return (
            <Box key={row.id} flexDirection="column">
              <Text wrap="truncate">
                <Text color={isSelected ? theme.accent : theme.muted}>
                  {isSelected ? "❯ " : "  "}
                </Text>
                <Text bold={isSelected} color={theme.text}>
                  {row.label.padEnd(18)}
                </Text>
                <Text color={row.editable ? theme.text : theme.muted}>{row.value}</Text>
                {row.editable ? (
                  <Text color={theme.muted}>  ·  ←/→ change</Text>
                ) : null}
              </Text>
              {isSelected && row.detail ? (
                <Text color={theme.muted} wrap="truncate">
                  {"    "}
                  {row.detail}
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>

      {preset === "permissive" ? (
        <Text color={theme.badge.running} wrap="truncate">
          Permissive allows credential reads and destructive commands unless an explicit deny rule exists.
        </Text>
      ) : null}
      <Text color={theme.muted} wrap="truncate">
        Up/Down select · Left/Right or Enter change · Esc close
      </Text>
      <Text color={theme.border.passive} wrap="truncate">
        {"─".repeat(contentWidth)}
      </Text>
    </Box>
  );
}
