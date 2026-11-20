import React from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { UI_LAYOUTS, type UiLayout } from "../types/ui-layout";
import type { ChatEntryView } from "./app";
import { LAYOUT_PRESETS } from "./layout";
import { isMouseSequence, parseMouseWheel } from "./mouse";
import { rowContent } from "./rows";
import { displayWidth, fitDisplayText, wrapText } from "./text-wrap";
import { buildTranscriptRows } from "./transcript-lines";
import {
  AUTO_THEME, THEME_ORDER, THEMES, getTheme, resolveThemeChoice,
  resolveThemeSelection, themeSelectionLabel, useActiveTheme,
  type ThemeSelection, type TerminalAppearance, type Theme,
} from "./theme";

export interface ThemePickerProps {
  layout: UiLayout;
  selection: ThemeSelection;
  appearance: TerminalAppearance;
  width: number;
  height: number;
  theme?: Theme;
  onSelectLayout?: (layout: UiLayout) => void;
  onSelectColor?: (selection: ThemeSelection) => void;
  onCancel: () => void;
}

const COLORS: ThemeSelection[] = [AUTO_THEME, ...THEME_ORDER];
const LAYOUT_SAMPLE: ChatEntryView[] = [
  { id: "theme-preview-user", role: "user", text: "Check the entry point" },
  { id: "theme-preview-answer", role: "assistant", text: "The entry point is registered." },
];
const LAYOUT_SAMPLE_WITH_TOOL: ChatEntryView[] = [
  LAYOUT_SAMPLE[0],
  {
    ...LAYOUT_SAMPLE[1],
    toolCalls: [{ name: "read_file", filePath: "src/index.ts", status: "ok", argumentsSummary: "" }],
  },
];
const NO_EXPANDED_GROUPS = new Set<string>();

function LayoutPreview({ layout, width, height, theme }: { layout: UiLayout; width: number; height: number; theme: Theme }) {
  const sample = height >= 8 ? LAYOUT_SAMPLE_WITH_TOOL : LAYOUT_SAMPLE;
  const rows = React.useMemo(() => buildTranscriptRows(sample, {
    layout, width, theme, collapsed: false, expandedGroups: NO_EXPANDED_GROUPS, thinkingExpanded: false,
  }).slice(0, height - 1), [layout, width, height, theme, sample]);
  return <Box flexDirection="column" flexShrink={0}>
    <Text color={theme.muted}>Preview</Text>
    {rows.map((row) => <Text key={row.key} wrap="truncate">{rowContent(row.node).node}</Text>)}
  </Box>;
}

export function ThemePicker(props: ThemePickerProps): React.ReactElement {
  const theme = useActiveTheme(props.theme);
  const [layoutTab, setLayoutTab] = React.useState(true);
  const [layoutIndex, setLayoutIndex] = React.useState(UI_LAYOUTS.indexOf(props.layout));
  const [colorIndex, setColorIndex] = React.useState(COLORS.indexOf(props.selection));
  const layout = UI_LAYOUTS[layoutIndex] ?? props.layout;
  const color = COLORS[colorIndex] ?? props.selection;
  const warning = !layoutTab && resolveThemeChoice(color, props.appearance).warning;
  const preview = getTheme(resolveThemeSelection(color, props.appearance));
  const height = Math.max(1, props.height);
  const width = Math.max(1, props.width);
  const selected = layoutTab ? layoutIndex : colorIndex;
  const count = layoutTab ? UI_LAYOUTS.length : COLORS.length;
  const detail = layoutTab ? LAYOUT_PRESETS[layout].description : warning
    ? `Requires a ${preview.appearance} terminal`
    : color === AUTO_THEME ? "Follow the terminal background" : THEMES[color].description;
  const detailLines = height >= 8 ? wrapText(detail, width).slice(0, 2)
    : warning && height >= 4 ? [detail] : [];
  const layoutPreviewRows = height >= 19 ? 8 : height >= 13 ? 4 : 0;
  const colorPreviewRows = height >= 13 ? 5 : height >= 8 ? 1 : 0;
  const previewRows = layoutTab ? layoutPreviewRows : colorPreviewRows;
  const showTabs = height >= 2;
  const showControls = height >= 3;
  const visible = Math.min(count, Math.max(1, height - Number(showTabs) - Number(showControls) - previewRows - detailLines.length));
  const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), count - visible));
  const move = React.useCallback((delta: number) => {
    const setIndex = layoutTab ? setLayoutIndex : setColorIndex;
    setIndex((index) => Math.max(0, Math.min(count - 1, index + delta)));
  }, [layoutTab, count]);
  const { stdin } = useStdin();
  React.useEffect(() => {
    const listener = (data: Buffer | string) => {
      const delta = parseMouseWheel(String(data));
      if (delta) move(-delta);
    };
    stdin.on("data", listener);
    return () => { stdin.off("data", listener); };
  }, [stdin, move]);
  useInput((input, key) => {
    if (isMouseSequence(input)) return;
    if (key.escape) props.onCancel();
    else if (key.tab) setLayoutTab((active) => !active);
    else if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-visible);
    else if (key.pageDown) move(visible);
    else if (key.return) {
      if (layoutTab && layout !== props.layout) props.onSelectLayout?.(layout);
      if (!layoutTab && !warning && color !== props.selection) props.onSelectColor?.(color);
    }
  });
  const colorLabel = (value: ThemeSelection): string => value === AUTO_THEME
    ? themeSelectionLabel(value, resolveThemeSelection(value, props.appearance))
    : THEMES[value].label;
  const options = layoutTab
    ? UI_LAYOUTS.map((id) => ({ id, label: LAYOUT_PRESETS[id].label, active: props.layout === id }))
    : COLORS.map((id) => ({ id, label: colorLabel(id), active: props.selection === id }));
  const line = (value: string) => fitDisplayText(value, width);
  const canApply = layoutTab ? Boolean(props.onSelectLayout) : Boolean(props.onSelectColor) && !warning;
  const controls = canApply ? "Tab switch · ↑/↓ · Enter apply · Esc" : "Tab switch · ↑/↓ · Esc close";
  const shortControls = canApply ? "Tab · ↑/↓ · Enter · Esc" : "Tab · ↑/↓ · Esc";
  return <Box flexDirection="column" width={width} height={height} overflow="hidden">
    {showTabs ? <Text color={theme.muted} wrap="truncate">
      <Text color={theme.text} bold>Theme</Text>{"  "}
      <Text color={layoutTab ? theme.selection : theme.muted} bold={layoutTab}>{layoutTab ? "[Layout]" : "Layout"}</Text>{"  "}
      <Text color={layoutTab ? theme.muted : theme.selection} bold={!layoutTab}>{layoutTab ? "Colors" : "[Colors]"}</Text>
    </Text> : null}
    <Box flexDirection="column" flexShrink={0}>
      {options.slice(start, start + visible).map((option, index) => {
        const focused = start + index === selected;
        return <Text key={option.id} color={focused ? theme.selection : theme.text} bold={focused} wrap="truncate">
          {line(`${focused ? "❯" : " "} ${option.label}${option.active ? " · active" : ""}`)}
        </Text>;
      })}
    </Box>
    {detailLines.map((detailLine, index) => <Text key={index} color={warning ? theme.status.warning : theme.muted} wrap="truncate">{line(detailLine)}</Text>)}
    {layoutTab && previewRows > 0 ? <LayoutPreview layout={layout} width={width} height={previewRows} theme={theme} /> : null}
    {!layoutTab && previewRows > 0 ? <Box flexDirection="column" height={previewRows} flexShrink={0}>
      <Text color={previewRows > 1 ? theme.muted : preview.text} backgroundColor={previewRows === 1 ? preview.background : undefined} wrap="truncate">{line(`Preview · ${preview.label}`)}</Text>
      {previewRows > 1 ? <Box flexDirection="column">
        <Text color={preview.text} backgroundColor={preview.background} wrap="truncate">{line("Answer: Updated the button style.")}</Text>
        <Text color={preview.muted} backgroundColor={preview.background} wrap="truncate">{line("Read file · button.tsx · Done")}</Text>
        <Text color={preview.selection} backgroundColor={preview.background} bold wrap="truncate">{line("❯ Selected item")}</Text>
        <Text backgroundColor={preview.background} wrap="truncate"><Text color={preview.diff.added}>+ added</Text><Text color={preview.diff.removed}>  - removed</Text></Text>
      </Box> : null}
    </Box> : null}
    {showControls ? <Text color={theme.muted} wrap="truncate">{line(displayWidth(controls) <= width ? controls : shortControls)}</Text> : null}
  </Box>;
}
