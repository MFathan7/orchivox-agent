import React from "react";
import { Box, Text, useInput } from "ink";

import type { ProviderRole, ProviderRouter } from "../provider/router";
import { filterFuzzy } from "./autocomplete";
import { getTheme, type Theme, type ThemeName, THEME_ORDER } from "./theme";

export type ReasoningEffortLevel = "off" | "low" | "medium" | "high" | "max";

export interface PaletteItem {
  id: string;
  category: "model" | "reasoning" | "theme" | "action";
  section: string;
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
  onSelectReasoning?: (effort: ReasoningEffortLevel) => void;
  onSelectTheme?: (theme: ThemeName) => void;
  onOpenModels?: () => void;
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
    onSelectReasoning,
    onSelectTheme,
    onOpenModels,
    onAction,
    onClose,
    theme = getTheme(currentTheme),
  } = props;

  const [query, setQuery] = React.useState("");
  const [selectedIndex, setSelectedIndex] = React.useState(0);

  const items = React.useMemo(() => {
    const list: PaletteItem[] = [];
    const roles: ProviderRole[] = ["main", "fast", "advisor"];

    for (const role of roles) {
      const active = router.getRole(role);
      list.push({
        id: `role-${role}`,
        category: "model",
        section: "Model roles",
        title: active ? `${role}: ${active.provider} / ${active.model}` : `${role}: not configured`,
        subtitle: active ? "Change in the model manager" : "Connect a provider first",
        badge: active ? undefined : "EMPTY",
        onExecute: () => {
          onOpenModels?.();
          onClose();
        },
      });
    }

    for (const level of REASONING_LEVELS) {
      const isCurrent = reasoningEffort === level.id;
      list.push({
        id: `reasoning-${level.id}`,
        category: "reasoning",
        section: "Thinking effort",
        title: level.label,
        subtitle: level.description,
        badge: isCurrent ? "ACTIVE" : undefined,
        isCurrent,
        onExecute: () => {
          onSelectReasoning?.(level.id);
          onClose();
        },
      });
    }

    for (const name of THEME_ORDER) {
      const isCurrent = currentTheme === name;
      list.push({
        id: `theme-${name}`,
        category: "theme",
        section: "Theme",
        title: name,
        subtitle: isCurrent ? "Current preset" : "Switch preset",
        badge: isCurrent ? "ACTIVE" : undefined,
        isCurrent,
        onExecute: () => {
          onSelectTheme?.(name);
          onClose();
        },
      });
    }

    const actions: Array<{ key: string; title: string; subtitle: string }> = [
      { key: "open_models", title: "Model manager", subtitle: "Roles, providers, and connections (/models)" },
      { key: "open_skills", title: "Skills", subtitle: "Inspect installed skills (/skills)" },
      { key: "open_tasks", title: "Task board", subtitle: "Multi-agent tasks and results (/tasks)" },
      { key: "open_sessions", title: "Sessions", subtitle: "Browse, search, fork, and restore (Ctrl+S)" },
      { key: "open_timeline", title: "Snapshot timeline", subtitle: "Inspect and restore file changes" },
      { key: "open_fork", title: "Fork session", subtitle: "Branch the active conversation" },
      { key: "open_hub", title: "Subagent hub", subtitle: "Inspect and steer workers (Alt+A)" },
      { key: "toggle_sidebar", title: "Toggle sidebar", subtitle: "Show or hide workspace status (Ctrl+B)" },
      { key: "run_commit", title: "Atomic commit", subtitle: "Split changes into commits (/commit)" },
      { key: "run_compact", title: "Compact context", subtitle: "Summarize history to save tokens (/compact)" },
      { key: "run_plugins", title: "List plugins", subtitle: "Show active plugins (/plugins)" },
    ];

    for (const action of actions) {
      list.push({
        id: `action-${action.key}`,
        category: "action",
        section: "Actions",
        title: action.title,
        subtitle: action.subtitle,
        onExecute: () => {
          onAction?.(action.key);
          onClose();
        },
      });
    }

    return list;
  }, [router, currentTheme, reasoningEffort, onSelectReasoning, onSelectTheme, onOpenModels, onAction, onClose]);

  const source = React.useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return items.filter((item) => item.category === "action");
    const ranked = filterFuzzy(trimmed, items, (item) => `${item.section} ${item.title} ${item.subtitle ?? ""}`, 50);
    return ranked.map((entry) => entry.item);
  }, [items, query]);

  const maxVisible = 10;
  const clampedIndex = Math.max(0, Math.min(source.length - 1, selectedIndex));
  const halfWindow = Math.floor(maxVisible / 2);
  let startIndex = Math.max(0, clampedIndex - halfWindow);
  if (startIndex + maxVisible > source.length) {
    startIndex = Math.max(0, source.length - maxVisible);
  }
  const visibleItems = source.slice(startIndex, startIndex + maxVisible);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, source.length - 1)));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((prev) => (prev < source.length - 1 ? prev + 1 : 0));
      return;
    }

    if (key.return) {
      const selected = source[clampedIndex];
      selected?.onExecute();
      return;
    }

    const isBackspace = Boolean(key.backspace || input === "\x7f" || input === "\b" || input === "\x1b[3~");
    if (isBackspace) {
      setQuery((prev) => prev.slice(0, -1));
      setSelectedIndex(0);
      return;
    }

    if (!key.ctrl && !key.meta && input.length > 0 && input >= " " && input !== "\x7f" && !input.startsWith("\x1b")) {
      setQuery((prev) => prev + input);
      setSelectedIndex(0);
    }
  });

  let lastSection = "";

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={theme.text}>Palette</Text>
        <Text color={theme.muted}>{source.length} matches · Esc close</Text>
      </Box>
      <Box borderStyle="single" borderColor={theme.border.passive} paddingX={1}>
        <Text color={theme.accent} bold>❯ </Text>
        <Text color={theme.text}>{query}</Text>
        <Text inverse color={theme.accent}> </Text>
        {query.length === 0 ? (
          <Text color={theme.muted}>  Type to search models, thinking effort, themes, and actions</Text>
        ) : null}
      </Box>

      <Box flexDirection="column" marginTop={0}>
        {visibleItems.length === 0 ? (
          <Text color={theme.muted}>No matches. Try a shorter query.</Text>
        ) : (
          visibleItems.map((item, index) => {
            const actualIndex = startIndex + index;
            const isSelected = actualIndex === clampedIndex;
            const showSection = item.section !== lastSection;
            lastSection = item.section;

            return (
              <Box key={item.id} flexDirection="column">
                {showSection ? (
                  <Text bold color={theme.modes.plan.primary}>{item.section}</Text>
                ) : null}
                <Box justifyContent="space-between">
                  <Box>
                    <Text color={isSelected ? theme.accent : theme.muted}>{isSelected ? "❯ " : "  "}</Text>
                    <Text color={isSelected ? theme.text : theme.text} bold={isSelected}>{item.title}</Text>
                    {item.subtitle ? <Text color={theme.muted}> · {item.subtitle}</Text> : null}
                  </Box>
                  {item.badge ? (
                    <Text color={item.badge === "EMPTY" ? theme.badge.error : theme.modes.build.primary} bold>
                      {item.badge}
                    </Text>
                  ) : null}
                </Box>
              </Box>
            );
          })
        )}
      </Box>

      <Box justifyContent="space-between">
        <Text color={theme.muted}>Up/Down move · Enter select · Esc close</Text>
        <Text color={theme.muted}>
          {source.length === 0 ? "0 of 0" : `${clampedIndex + 1} of ${source.length}`}
        </Text>
      </Box>
    </Box>
  );
}
