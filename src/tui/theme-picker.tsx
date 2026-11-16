import React from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { isMouseSequence, parseMouseWheel } from "./mouse";
import { fitDisplayText } from "./text-wrap";
import {
  AUTO_THEME, THEME_ORDER, THEMES, getTheme, resolveThemeChoice,
  resolveThemeSelection, themeSelectionLabel, useActiveTheme,
  type ThemeSelection, type TerminalAppearance, type Theme,
} from "./theme";

export interface ThemePickerProps {
  selection: ThemeSelection;
  appearance: TerminalAppearance;
  width: number;
  height: number;
  theme?: Theme;
  onSelect: (selection: ThemeSelection) => void;
  onCancel: () => void;
}

const OPTIONS: ThemeSelection[] = [AUTO_THEME, ...THEME_ORDER];

export function ThemePicker(props: ThemePickerProps): React.ReactElement {
  const theme = useActiveTheme(props.theme);
  const [selected, setSelected] = React.useState(Math.max(0, OPTIONS.indexOf(props.selection)));
  const candidate = OPTIONS[selected];
  const choice = resolveThemeChoice(candidate, props.appearance);
  const preview = getTheme(resolveThemeSelection(candidate, props.appearance));
  const height = Math.max(4, props.height);
  const width = Math.max(1, props.width);
  const previewRows = height >= 12 ? 5 : height >= 6 ? 1 : 0;
  const currentRows = height >= 10 ? 1 : 0;
  const descriptionRows = height >= 8 ? 1 : 0;
  const visible = Math.max(1, height - 3 - previewRows - currentRows - descriptionRows);
  const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), OPTIONS.length - visible));
  const move = React.useCallback((delta: number) => {
    setSelected((index) => Math.max(0, Math.min(OPTIONS.length - 1, index + delta)));
  }, []);
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
    else if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-visible);
    else if (key.pageDown) move(visible);
    else if (key.return && !choice.warning) props.onSelect(candidate);
  });
  const label = (value: ThemeSelection): string => value === AUTO_THEME
    ? themeSelectionLabel(value, resolveThemeSelection(value, props.appearance))
    : THEMES[value].label;
  const line = (value: string) => fitDisplayText(value, width);
  return <Box flexDirection="column" width={width} height={height} overflow="hidden">
    <Text color={theme.text} bold wrap="truncate">{line(`Theme · ${selected + 1}/${OPTIONS.length}`)}</Text>
    {currentRows ? <Text color={theme.muted} wrap="truncate">{line(`Saved: ${label(props.selection)}`)}</Text> : null}
    <Box flexDirection="column" height={visible} flexShrink={0}>
      {OPTIONS.slice(start, start + visible).map((option, index) => <Text key={option}
        color={start + index === selected ? theme.selection : theme.text} bold={start + index === selected} wrap="truncate">
        {line(`${start + index === selected ? "❯" : " "} ${label(option)}${option === props.selection ? " · saved" : ""}`)}
      </Text>)}
    </Box>
    {descriptionRows ? <Text color={theme.muted} wrap="truncate">{line(candidate === AUTO_THEME
      ? "Follow the terminal background" : `${THEMES[candidate].appearance} · ${THEMES[candidate].description}`)}</Text> : null}
    <Text color={choice.warning ? theme.status.warning : theme.muted} wrap="truncate">{line(choice.warning
      ? `Enter unavailable · use ${candidate === AUTO_THEME ? "matching" : THEMES[candidate].appearance} terminal`
      : "Preview only until you press Enter")}</Text>
    {previewRows ? <Box flexDirection="column" height={previewRows} flexShrink={0}>
      <Text color={previewRows > 1 ? theme.muted : preview.text} backgroundColor={previewRows === 1 ? preview.background : undefined} wrap="truncate">{line(`Preview · ${preview.label}`)}</Text>
      {previewRows > 1 ? <Box flexDirection="column">
        <Text color={preview.text} backgroundColor={preview.background} wrap="truncate">{line("Answer: Updated the button style.")}</Text>
        <Text color={preview.muted} backgroundColor={preview.background} wrap="truncate">{line("Read file · button.tsx · Done")}</Text>
        <Text color={preview.selection} backgroundColor={preview.background} bold wrap="truncate">{line("❯ Selected item")}</Text>
        <Text backgroundColor={preview.background} wrap="truncate"><Text color={preview.diff.added}>+ added</Text><Text color={preview.diff.removed}>  - removed</Text></Text>
      </Box> : null}
    </Box> : null}
    <Text color={theme.muted} wrap="truncate">{line(choice.warning ? "↑/↓ Wheel · Esc cancel" : "↑/↓ Wheel · Enter apply · Esc cancel")}</Text>
  </Box>;
}
