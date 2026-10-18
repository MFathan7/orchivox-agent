import React from "react";
import { Box, Text, useInput } from "ink";

import type { ProviderRole, ProviderRouter } from "../provider/router";
import { filterFuzzy } from "./autocomplete";
import { getTheme, type Theme, type ThemeName, THEME_ORDER } from "./theme";

export type ReasoningEffortLevel = "off" | "low" | "medium" | "high" | "max";

export interface PaletteItem {
  id: string;
  category: "model" | "reasoning" | "theme" | "action";
  title: string;
  subtitle?: string;
  badge?: string;
  isCurrent?: boolean;
  onExecute: () => void;
}

export interface CommandPaletteModalProps {
  router: ProviderRouter;
  currentTheme?: ThemeName;
  reasoningEffort?: ReasoningEffortLevel;
  onSelectModel?: (role: ProviderRole, provider: string, model: string) => void;
  onSelectReasoning?: (effort: ReasoningEffortLevel) => void;
  onSelectTheme?: (theme: ThemeName) => void;
  onAction?: (actionKey: string) => void;
  onClose: () => void;
  theme?: Theme;
}

export const REASONING_LEVELS: Array<{ id: ReasoningEffortLevel; label: string; description: string; tokens: number }> = [
  { id: "off", label: "Off", description: "No thinking tokens (0 tokens)", tokens: 0 },
  { id: "low", label: "Low", description: "Concise and fast reasoning (2,048 tokens)", tokens: 2048 },
  { id: "medium", label: "Medium", description: "Standard structured reasoning (8,192 tokens)", tokens: 8192 },
  { id: "high", label: "High", description: "Deep reasoning for complex architecture (16,384 tokens)", tokens: 16384 },
  { id: "max", label: "Max", description: "Maximum reasoning for difficult tasks (32,768 tokens)", tokens: 32768 },
];

export function CommandPaletteModal(props: CommandPaletteModalProps) {
  const {
    router,
    currentTheme = "tokyonight",
    reasoningEffort = "medium",
    onSelectModel,
    onSelectReasoning,
    onSelectTheme,
    onAction,
    onClose,
    theme = getTheme(currentTheme),
  } = props;

  const [query, setQuery] = React.useState("");
  const [selectedIndex, setSelectedIndex] = React.useState(0);

  const items = React.useMemo(() => {
    const list: PaletteItem[] = [];

    const configuredModels = router.listAllConfiguredModels();
    const roles: ProviderRole[] = ["main", "fast", "advisor"];

    for (const role of roles) {
      const active = router.getRole(role);
      for (const entry of configuredModels) {
        const isCurrent = active?.provider === entry.provider && active?.model === entry.model;
        list.push({
          id: `model-${role}-${entry.provider}-${entry.model}`,
          category: "model",
          title: `Set ${role.toUpperCase()} -> ${entry.provider}: ${entry.model}`,
          subtitle: `${entry.kind} provider`,
          badge: isCurrent ? "ACTIVE" : undefined,
          isCurrent,
          onExecute: () => {
            router.setRole(role, entry.provider, entry.model);
            onSelectModel?.(role, entry.provider, entry.model);
            onClose();
          },
        });
      }
    }

    for (const lvl of REASONING_LEVELS) {
      const isCurrent = reasoningEffort === lvl.id;
      list.push({
        id: `reasoning-${lvl.id}`,
        category: "reasoning",
        title: `Thinking Effort: ${lvl.label}`,
        subtitle: lvl.description,
        badge: isCurrent ? "ACTIVE" : undefined,
        isCurrent,
        onExecute: () => {
          onSelectReasoning?.(lvl.id);
          onClose();
        },
      });
    }

    for (const th of THEME_ORDER) {
      const isCurrent = currentTheme === th;
      list.push({
        id: `theme-${th}`,
        category: "theme",
        title: `Change Theme: ${th}`,
        subtitle: `Terminal color theme preset for ${th}`,
        badge: isCurrent ? "ACTIVE" : undefined,
        isCurrent,
        onExecute: () => {
          onSelectTheme?.(th);
          onClose();
        },
      });
    }

    list.push(
      {
        id: "action-commit",
        category: "action",
        title: "Atomic Git Commit (/commit)",
        subtitle: "Split working tree changes into atomic commits",
        onExecute: () => {
          onAction?.("/commit");
          onClose();
        },
      },
      {
        id: "action-compact",
        category: "action",
        title: "Compact Context Window (/compact)",
        subtitle: "Summarize conversation history to save context tokens",
        onExecute: () => {
          onAction?.("/compact");
          onClose();
        },
      },
      {
        id: "action-plugins",
        category: "action",
        title: "List Active Plugins (/plugins)",
        subtitle: "Inspect status of loaded agent plugins",
        onExecute: () => {
          onAction?.("/plugins");
          onClose();
        },
      },
      {
        id: "action-sidebar",
        category: "action",
        title: "Toggle Workspace Sidebar (Ctrl+B)",
        subtitle: "Show or hide the right workspace status sidebar",
        onExecute: () => {
          onAction?.("toggle_sidebar");
          onClose();
        },
      },
      {
        id: "action-hub",
        category: "action",
        title: "Open Subagent Hub (Alt+A)",
        subtitle: "Manage background subagent workers and steering",
        onExecute: () => {
          onAction?.("open_hub");
          onClose();
        },
      },
      {
        id: "action-sessions",
        category: "action",
        title: "Session Time-Travel Manager (Ctrl+S)",
        subtitle: "Browse past conversations, fork sessions, or restore snapshots",
        onExecute: () => {
          onAction?.("open_sessions");
          onClose();
        },
      },
    );

    return list;
  }, [router, currentTheme, reasoningEffort, onSelectModel, onSelectReasoning, onSelectTheme, onAction, onClose]);

  const filteredItems = React.useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return items;
    const ranked = filterFuzzy(trimmed, items, (item) => `${item.category} ${item.title} ${item.subtitle ?? ""}`, 50);
    return ranked.map((r) => r.item);
  }, [items, query]);

  const maxVisible = 10;
  const clampedIndex = Math.max(0, Math.min(filteredItems.length - 1, selectedIndex));
  const halfWindow = Math.floor(maxVisible / 2);
  let startIndex = Math.max(0, clampedIndex - halfWindow);
  if (startIndex + maxVisible > filteredItems.length) {
    startIndex = Math.max(0, filteredItems.length - maxVisible);
  }
  const visibleItems = filteredItems.slice(startIndex, startIndex + maxVisible);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filteredItems.length - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => (prev < filteredItems.length - 1 ? prev + 1 : 0));
      return;
    }

    if (key.return) {
      const selected = filteredItems[clampedIndex];
      if (selected) {
        selected.onExecute();
      }
      return;
    }

    const isBackspace = Boolean(key.backspace || key.delete || input === "\x7f" || input === "\b" || input === "\x1b[3~");

    if (isBackspace) {
      setQuery((prev) => prev.slice(0, -1));
      setSelectedIndex(0);
      return;
    }

    if (!key.ctrl && !key.meta && !isBackspace && input.length > 0 && input >= " " && input !== "\x7f") {
      setQuery((prev) => prev + input);
      setSelectedIndex(0);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.active}
      paddingX={1}
      marginY={1}
    >
      <Box justifyContent="space-between" marginBottom={0}>
        <Text bold color={theme.accent}>
          COMMAND PALETTE &amp; SETTINGS
        </Text>
        <Text dimColor>
          {filteredItems.length} options available  |  Esc Close
        </Text>
      </Box>

      <Box borderStyle="single" borderColor={theme.border.passive} paddingX={1} marginY={0}>
        <Text color={theme.accent} bold>
          &gt;{" "}
        </Text>
        <Text>{query}</Text>
        <Text inverse color={theme.accent}> </Text>
        {query.length === 0 ? (
          <Text dimColor>Type to search models, reasoning, themes, or actions...</Text>
        ) : null}
      </Box>

      <Box flexDirection="column" marginY={1}>
        {visibleItems.length === 0 ? (
          <Text dimColor>No actions match your search.</Text>
        ) : (
          visibleItems.map((item, idx) => {
            const actualIndex = startIndex + idx;
            const isSelected = actualIndex === clampedIndex;

            let catColor = theme.muted;
            if (item.category === "model") catColor = theme.modes.plan.primary;
            if (item.category === "reasoning") catColor = theme.modes.ultrawork.primary;
            if (item.category === "theme") catColor = theme.modes.build.primary;
            if (item.category === "action") catColor = theme.accent;

            return (
              <Box key={item.id} justifyContent="space-between">
                <Box>
                  <Text color={isSelected ? theme.accent : undefined} bold={isSelected}>
                    {isSelected ? "❯ " : "  "}
                  </Text>
                  <Text color={catColor}>{item.category.toUpperCase()} </Text>
                  <Text color={isSelected ? theme.accent : undefined} bold={isSelected}>
                    {item.title}
                  </Text>
                  {item.subtitle ? <Text dimColor> · {item.subtitle}</Text> : null}
                </Box>
                {item.badge ? (
                  <Text color={theme.modes.build.primary} bold>
                    {item.badge}
                  </Text>
                ) : null}
              </Box>
            );
          })
        )}
      </Box>

      <Box justifyContent="space-between">
        <Text dimColor>
          Navigate: Up/Down · Select: Enter · Close: Esc
        </Text>
        <Text dimColor>
          {clampedIndex + 1} of {filteredItems.length}
        </Text>
      </Box>
    </Box>
  );
}
