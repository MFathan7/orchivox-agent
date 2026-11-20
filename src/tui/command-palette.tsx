import React from "react";
import { Box, Text, useInput } from "ink";

import type { ProviderRole, ProviderRouter } from "../provider/router";
import { filterFuzzy } from "./autocomplete";
import { isMouseSequence } from "./mouse";
import { displayWidth, fitDisplayText } from "./text-wrap";
import { useActiveTheme, type Theme } from "./theme";

export type ReasoningEffortLevel = "default" | "off" | "low" | "medium" | "high" | "max" | (string & {});

export interface PaletteItem {
  id: string;
  category: "model" | "reasoning" | "action";
  section: string;
  title: string;
  subtitle?: string;
  badge?: string;
  isCurrent?: boolean;
  onExecute: () => void;
}

export interface CommandPaletteModalProps {
  router: ProviderRouter;
  width?: number;
  height?: number;
  reasoningEffort?: ReasoningEffortLevel;
  reasoningLevels?: string[];
  onSelectReasoning?: (effort: ReasoningEffortLevel) => void;
  onOpenModels?: () => void;
  onAction?: (actionKey: string) => void;
  onClose: () => void;
  theme?: Theme;
}

export const REASONING_LEVELS: Array<{ id: ReasoningEffortLevel; label: string; description: string; tokens: number }> = [
  { id: "default", label: "Default", description: "Use the provider default, no override", tokens: 0 },
  { id: "off", label: "Off", description: "Disable reasoning when the provider supports it", tokens: 0 },
  { id: "low", label: "Low", description: "Concise and fast reasoning (2,048 tokens)", tokens: 2048 },
  { id: "medium", label: "Medium", description: "Standard structured reasoning (8,192 tokens)", tokens: 8192 },
  { id: "high", label: "High", description: "Deep reasoning for complex architecture (16,384 tokens)", tokens: 16384 },
  { id: "max", label: "Max", description: "Maximum reasoning for difficult tasks (32,768 tokens)", tokens: 32768 },
];

export function reasoningLevelsFor(
  efforts: string[],
): Array<{ id: ReasoningEffortLevel; label: string; description: string; tokens: number }> {
  const known = new Map(REASONING_LEVELS.map((level) => [level.id, level]));
  return efforts.map((effort) => {
    const id = effort as ReasoningEffortLevel;
    return (
      known.get(id) ?? {
        id,
        label: effort,
        description: "Model-specific reasoning effort",
        tokens: 0,
      }
    );
  });
}

export function CommandPaletteModal(props: CommandPaletteModalProps) {
  const {
    router,
    width = 80,
    height = 18,
    reasoningEffort = "default",
    reasoningLevels,
    onSelectReasoning,
    onOpenModels,
    onAction,
    onClose,
    theme: themeProp,
  } = props;
  const theme = useActiveTheme(themeProp);

  const levels = React.useMemo(
    () => reasoningLevelsFor(reasoningLevels ?? REASONING_LEVELS.map((level) => level.id)),
    [reasoningLevels],
  );

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

    const reasoningUnavailable = levels.length === 1 && levels[0]?.id === "default";
    for (const level of levels) {
      const isCurrent = reasoningEffort === level.id;
      list.push({
        id: `reasoning-${level.id}`,
        category: "reasoning",
        section: "Thinking effort",
        title: level.label,
        subtitle: reasoningUnavailable ? "This model does not expose reasoning controls" : level.description,
        badge: isCurrent ? "ACTIVE" : undefined,
        isCurrent,
        onExecute: () => {
          onSelectReasoning?.(level.id);
          onClose();
        },
      });
    }

    const actions: Array<{ key: string; title: string; subtitle: string }> = [
      {
        key: "open_models",
        title: "Model manager",
        subtitle: "Type to search models and assign roles (/models)",
      },
      { key: "open_connect", title: "Provider manager", subtitle: "Add, edit, enable, or delete providers (/connect)" },
      { key: "open_skills", title: "Skills", subtitle: "Inspect installed skills (/skills)" },
      { key: "open_settings", title: "Settings", subtitle: "Approvals, safety, and step limits (/settings)" },
      { key: "open_theme", title: "Theme", subtitle: "Layout and colors (/theme)" },
      { key: "open_tasks", title: "Task board", subtitle: "Multi-agent tasks and results (/tasks)" },
      { key: "open_sessions", title: "Sessions", subtitle: "Browse, search, fork, and restore (Ctrl+S)" },
      { key: "open_timeline", title: "Snapshot timeline", subtitle: "Inspect and restore file changes" },
      { key: "open_fork", title: "Fork session", subtitle: "Branch the active conversation" },
      { key: "open_hub", title: "Subagent hub", subtitle: "Inspect and steer workers (Alt+A)" },
      { key: "toggle_sidebar", title: "Toggle sidebar", subtitle: "Show or hide workspace status (Ctrl+B)" },
      { key: "run_commit", title: "Atomic commit", subtitle: "Split changes into commits (/commit)" },
      { key: "run_compact", title: "Compact context", subtitle: "Summarize history to save tokens (/compact)" },
      { key: "run_plugins", title: "List plugins", subtitle: "Show active plugins (/plugins)" },
      { key: "run_stats", title: "Session statistics", subtitle: "Context, request, spend, and last turn (/stats)" },
      { key: "run_turn_report", title: "Turn report", subtitle: "Steps, tools, and budget for the last turn (/turn-report)" },
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
  }, [router, reasoningEffort, levels, onSelectReasoning, onOpenModels, onAction, onClose]);

  const source = React.useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return items.filter((item) => item.category === "action");
    const ranked = filterFuzzy(trimmed, items, (item) => `${item.section} ${item.title} ${item.subtitle ?? ""}`, 50);
    return ranked.map((entry) => entry.item);
  }, [items, query]);

  const contentWidth = Math.max(1, width - 2);
  const showHeading = height >= 4;
  const showSearch = height >= 2;
  const framedSearch = height >= 7 && contentWidth >= 12;
  const searchHeight = showSearch ? framedSearch ? 3 : 1 : 0;
  const listHeight = Math.max(1, height - searchHeight - (showHeading ? 2 : 0));
  const maxVisible = Math.min(10, listHeight);
  const clampedIndex = Math.max(0, Math.min(source.length - 1, selectedIndex));
  const halfWindow = Math.floor(maxVisible / 2);
  let startIndex = Math.max(0, clampedIndex - halfWindow);
  if (startIndex + maxVisible > source.length) {
    startIndex = Math.max(0, source.length - maxVisible);
  }
  const visibleItems = source.slice(startIndex, startIndex + maxVisible);
  const sectionRows = visibleItems.filter((item, index) => item.section !== visibleItems[index - 1]?.section).length;
  const showSections = visibleItems.length + sectionRows <= listHeight;

  useInput((input, key) => {
    if (isMouseSequence(input)) return;
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

    if (key.ctrl && input === "u") {
      setQuery("");
      setSelectedIndex(0);
      return;
    }

    const isBackspace = Boolean(
      key.backspace || key.delete || input === "\x7f" || input === "\b" || input === "\x1b[3~",
    );
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

  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      {showHeading ? <Text wrap="truncate">
        <Text bold color={theme.text}>Palette</Text>
        <Text color={theme.muted}> · {source.length} matches</Text>
      </Text> : null}
      {showSearch ? <Box borderStyle={framedSearch ? "single" : undefined} borderColor={theme.border.passive} paddingX={framedSearch ? 1 : 0} flexShrink={0}>
        <Text wrap="truncate">
          <Text color={theme.accent} bold>❯ </Text>
          <Text color={query ? theme.text : theme.muted}>
            {fitDisplayText(query || "Search models, effort, and actions", Math.max(0, contentWidth - (framedSearch ? 7 : 3)))}
          </Text>
          {query ? <Text inverse color={theme.accent}> </Text> : null}
        </Text>
      </Box> : null}

      <Box flexDirection="column" flexShrink={0}>
        {visibleItems.length === 0 ? (
          <Text color={theme.muted} wrap="truncate">{fitDisplayText("No matches. Try a shorter query.", contentWidth)}</Text>
        ) : (
          visibleItems.map((item, index) => {
            const actualIndex = startIndex + index;
            const isSelected = actualIndex === clampedIndex;
            const showSection = showSections && item.section !== visibleItems[index - 1]?.section;
            const badge = item.badge ? ` · ${item.badge}` : "";
            const rowWidth = Math.max(1, contentWidth - 2 - displayWidth(badge));
            const title = fitDisplayText(item.title, rowWidth);
            const spare = rowWidth - displayWidth(title);
            const detail = item.subtitle && spare >= 5 ? fitDisplayText(` · ${item.subtitle}`, spare) : "";

            return (
              <Box key={item.id} flexDirection="column">
                {showSection ? (
                  <Text bold color={theme.accent} wrap="truncate">{item.section}</Text>
                ) : null}
                <Text wrap="truncate">
                  <Text color={isSelected ? theme.accent : theme.muted}>{isSelected ? "❯ " : "  "}</Text>
                  <Text color={isSelected ? theme.selection : theme.text} bold={isSelected}>{title}</Text>
                  <Text color={theme.muted}>{detail}</Text>
                  {badge ? (
                    <Text color={item.badge === "EMPTY" ? theme.status.error : theme.status.success} bold>
                      {badge}
                    </Text>
                  ) : null}
                </Text>
              </Box>
            );
          })
        )}
      </Box>

      {showHeading ? <Text color={theme.muted} wrap="truncate">
        {fitDisplayText("↑/↓ move · Enter select · Esc close", contentWidth)}
      </Text> : null}
    </Box>
  );
}
