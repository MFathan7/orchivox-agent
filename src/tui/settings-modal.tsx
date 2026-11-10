import React from "react";
import { Box, Text, useInput } from "ink";

import type { ApprovalPreset, AutoDelegateMode, WorkerFallbackMode } from "../config/loader";
import type { BackgroundConfig, DelegationPolicy, LimitsConfig } from "../config/loader";
import { isMouseSequence } from "./mouse";
import { useActiveTheme, type Theme } from "./theme";

export type SettingsMode = "plan" | "build" | "ultrawork";

export interface SettingsModalProps {
  limits?: LimitsConfig;
  onLimitsChange?: (patch: Partial<LimitsConfig>) => void;
  delegation?: DelegationPolicy;
  onDelegationChange?: (value: DelegationPolicy) => void;
  background?: BackgroundConfig;
  onBackgroundChange?: (patch: Partial<BackgroundConfig>) => void;
  workerTimeoutSeconds?: number;
  onWorkerTimeoutChange?: (seconds: number) => void;
  workerFallback?: WorkerFallbackMode;
  onWorkerFallbackChange?: (value: WorkerFallbackMode) => void;
  animations?: boolean;
  onAnimationsChange?: (enabled: boolean) => void;
  preset: ApprovalPreset;
  autoDelegate: AutoDelegateMode;
  steps: Record<SettingsMode, number>;
  configPath: string;
  configSource: string;
  width?: number;
  height?: number;
  theme?: Theme;
  onPresetChange: (preset: ApprovalPreset) => void;
  onAutoDelegateChange: (mode: AutoDelegateMode) => void;
  onStepsChange: (mode: SettingsMode, steps: number) => void;
  onClose: () => void;
}

const PRESETS: ApprovalPreset[] = ["safer", "env-only", "permissive", "custom"];
const STEP_VALUES = [0, 10, 20, 40, 80, 160];
const MODES: SettingsMode[] = ["plan", "build", "ultrawork"];
const DELEGATION_VALUES: DelegationPolicy[] = ["requested", "balanced", "eager"];
export const DELEGATION_LABELS: Record<DelegationPolicy, string> = {
  requested: "On request", balanced: "Balanced", eager: "Prefer parallel",
};
const DELEGATION_DETAILS: Record<DelegationPolicy, string> = {
  requested: "Delegate when the user or project instructions explicitly request agents.",
  balanced: "Use workers for substantial independent work while the main agent continues.",
  eager: "Prefer parallel workers for substantial independent slices; keep shared edits together.",
};
const TURN_LIMIT_ROWS = {
  checkpoint_interval: { label: "Progress check", fallback: 25, values: [0, 10, 25, 50, 100], detail: "Review remaining work every N tool calls, within the next model request. 0 disables checkpoints." },
  max_tool_calls: { label: "Turn tool limit", fallback: 100, values: [0, 50, 100, 200, 400], detail: "Maximum tool calls per turn, followed by one summary. Work is retained. 0 disables this limit." },
  max_wall_seconds: { label: "Turn time limit", fallback: 1200, values: [0, 300, 600, 1200, 1800, 3600], detail: "Cancel foreground requests and tools when the turn time expires. 0 disables this limit." },
} as const;

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

const AUTO_DELEGATE_VALUES: AutoDelegateMode[] = ["off", "ultrawork", "always"];

export const AUTO_DELEGATE_LABELS: Record<AutoDelegateMode, string> = {
  off: "Off",
  ultrawork: "Ultrawork only",
  always: "On demand",
};

export const AUTO_DELEGATE_DESCRIPTIONS: Record<AutoDelegateMode, string> = {
  off: "Coordinator unavailable. The main agent can still delegate directly.",
  ultrawork: "Optional Polaris planner in Ultrawork. No automatic planning pass.",
  always: "Optional Polaris planner in Build and Ultrawork. The main agent decides when it helps.",
};

const WORKER_FALLBACK_VALUES: WorkerFallbackMode[] = ["off", "main"];

export const WORKER_FALLBACK_LABELS: Record<WorkerFallbackMode, string> = {
  off: "Off",
  main: "Main model",
};

export const WORKER_FALLBACK_DESCRIPTIONS: Record<WorkerFallbackMode, string> = {
  off: "A failed worker stays failed. No model switch.",
  main: "Retry a retryable worker provider failure once on the session model.",
};

interface Row {
  id: "preset" | "auto_delegate" | "delegation" | keyof typeof TURN_LIMIT_ROWS | "animations" | "worker_timeout" | "worker_fallback" | "titles" | "recap" | "recap_delay" | SettingsMode | "config";
  label: string;
  value: string;
  detail?: string;
  editable: boolean;
}

function nextAutoDelegate(
  current: AutoDelegateMode,
  direction: 1 | -1,
): AutoDelegateMode {
  const index = Math.max(0, AUTO_DELEGATE_VALUES.indexOf(current));
  return (
    AUTO_DELEGATE_VALUES[
      (index + direction + AUTO_DELEGATE_VALUES.length) % AUTO_DELEGATE_VALUES.length
    ] ?? "off"
  );
}

function nextWorkerFallback(
  current: WorkerFallbackMode,
  direction: 1 | -1,
): WorkerFallbackMode {
  const index = Math.max(0, WORKER_FALLBACK_VALUES.indexOf(current));
  return (
    WORKER_FALLBACK_VALUES[
      (index + direction + WORKER_FALLBACK_VALUES.length) % WORKER_FALLBACK_VALUES.length
    ] ?? "off"
  );
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
    autoDelegate,
    steps,
    configPath,
    configSource,
    width = 100,
    theme: themeProp,
    onPresetChange,
    onAutoDelegateChange,
    onStepsChange,
    onClose,
  } = props;
  const theme = useActiveTheme(themeProp);
  const [selected, setSelected] = React.useState(0);
  const rows: Row[] = [
    {
      id: "animations", label: "Animations", value: props.animations === false ? "Off" : "On",
      detail: "Animate activity text and tool indicators. Turn off to keep them still.",
      editable: Boolean(props.onAnimationsChange),
    },
    {
      id: "preset",
      label: "Approval preset",
      value: PRESET_LABELS[preset],
      detail: PRESET_DESCRIPTIONS[preset],
      editable: true,
    },
    {
      id: "auto_delegate",
      label: "Coordinator",
      value: AUTO_DELEGATE_LABELS[autoDelegate],
      detail: AUTO_DELEGATE_DESCRIPTIONS[autoDelegate],
      editable: true,
    },
    { id: "delegation", label: "Delegation", value: DELEGATION_LABELS[props.delegation ?? "balanced"],
      detail: DELEGATION_DETAILS[props.delegation ?? "balanced"], editable: Boolean(props.onDelegationChange) },
    ...Object.entries(TURN_LIMIT_ROWS).map(([id, row]) => {
      const key = id as keyof typeof TURN_LIMIT_ROWS;
      const value = props.limits?.[key] ?? row.fallback;
      return { id: key, label: row.label, value: value === 0 ? "Off" : `${value}${key === "max_wall_seconds" ? "s" : " calls"}`, detail: row.detail, editable: Boolean(props.onLimitsChange) };
    }),
    {
      id: "worker_timeout", label: "Worker time limit",
      value: props.workerTimeoutSeconds ? `${props.workerTimeoutSeconds}s` : "Off",
      detail: "Total time per new worker, including preparation. 0 disables this limit.",
      editable: Boolean(props.onWorkerTimeoutChange),
    },
    {
      id: "worker_fallback", label: "Worker fallback",
      value: WORKER_FALLBACK_LABELS[props.workerFallback ?? "off"],
      detail: WORKER_FALLBACK_DESCRIPTIONS[props.workerFallback ?? "off"],
      editable: Boolean(props.onWorkerFallbackChange),
    },
    ...MODES.map((mode) => ({
      id: mode,
      label: `${mode[0]?.toUpperCase()}${mode.slice(1)} steps`,
      value: steps[mode] === 0 ? "unlimited" : String(steps[mode]),
      detail: steps[mode] === 0 ? "0 means no step limit" : "model steps per turn",
      editable: true,
    })),
    { id: "titles", label: "Background titles", value: props.background?.titles === false ? "Off" : "On",
      detail: "A short model request while the answer streams. Usage is added to the session.", editable: Boolean(props.onBackgroundChange) },
    { id: "recap", label: "Idle recap", value: props.background?.recap === false ? "Off" : "On",
      detail: "A separate model request after idle time. Typing or new work cancels it.", editable: Boolean(props.onBackgroundChange) },
    { id: "recap_delay", label: "Recap delay", value: `${props.background?.recap_idle_seconds ?? 240}s`,
      detail: "Wait after the answer and background workers finish.", editable: Boolean(props.onBackgroundChange) },
    {
      id: "config",
      label: "Config",
      value: configPath,
      detail: configSource,
      editable: false,
    },
  ];
  const clamped = Math.max(0, Math.min(selected, rows.length - 1));
  const notes = Number(autoDelegate === "always") + Number(preset === "permissive");
  const visibleRows = Math.max(1, (props.height ?? 24) - 5 - notes);
  const start = Math.max(0, Math.min(clamped - visibleRows + 1, rows.length - visibleRows));

  const change = (direction: 1 | -1): void => {
    const row = rows[clamped];
    if (!row?.editable) return;
    if (row.id === "checkpoint_interval" || row.id === "max_tool_calls" || row.id === "max_wall_seconds") {
      const setting = TURN_LIMIT_ROWS[row.id];
      const current = props.limits?.[row.id] ?? setting.fallback;
      const values: readonly number[] = setting.values;
      const next = direction === 1 ? values.find((value) => value > current) ?? values[0]!
        : [...values].reverse().find((value) => value < current) ?? values.at(-1)!;
      props.onLimitsChange?.({ [row.id]: next });
      return;
    }
    if (row.id === "delegation") {
      const index = DELEGATION_VALUES.indexOf(props.delegation ?? "balanced");
      props.onDelegationChange?.(DELEGATION_VALUES[(index + direction + DELEGATION_VALUES.length) % DELEGATION_VALUES.length]!);
      return;
    }
    if (row.id === "titles" || row.id === "recap") {
      props.onBackgroundChange?.({ [row.id]: props.background?.[row.id] === false });
      return;
    }
    if (row.id === "recap_delay") {
      const values = [60, 120, 240, 300, 600];
      const current = props.background?.recap_idle_seconds ?? 240;
      const next = direction === 1 ? values.find((value) => value > current) ?? 60
        : [...values].reverse().find((value) => value < current) ?? 600;
      props.onBackgroundChange?.({ recap_idle_seconds: next });
      return;
    }
    if (row.id === "worker_timeout") {
      const current = props.workerTimeoutSeconds ?? 0;
      const values = [0, 60, 120, 300, 600, 1200];
      const next = direction === 1 ? values.find((value) => value > current) ?? 0
        : [...values].reverse().find((value) => value < current) ?? 1200;
      props.onWorkerTimeoutChange?.(next);
      return;
    }
    if (row.id === "worker_fallback") {
      props.onWorkerFallbackChange?.(nextWorkerFallback(props.workerFallback ?? "off", direction));
      return;
    }
    if (row.id === "animations") {
      props.onAnimationsChange?.(props.animations === false);
      return;
    }
    if (row.id === "preset") {
      onPresetChange(nextPreset(preset, direction));
      return;
    }
    if (row.id === "auto_delegate") {
      onAutoDelegateChange(nextAutoDelegate(autoDelegate, direction));
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
    <Box flexDirection="column" width={Math.max(24, width)} height={props.height} overflow="hidden" paddingX={1}>
      <Box justifyContent="space-between" height={1} flexShrink={0}>
        <Text bold color={theme.text}>
          Settings
        </Text>
        <Text color={theme.muted}>Esc close</Text>
      </Box>
      <Text color={theme.muted} wrap="truncate">Appearance, safety, and orchestration</Text>

      <Box flexDirection="column" flexShrink={0}>
        {rows.slice(start, start + visibleRows).map((row, index) => {
          const isSelected = start + index === clamped;
          return (
            <Box key={row.id} flexDirection="column" flexShrink={0}>
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

      {autoDelegate === "always" ? (
        <Text color={theme.badge.running} wrap="truncate">
          Polaris runs only when the main agent calls coordinate; ordinary turns start directly.
        </Text>
      ) : null}
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
