import React from "react";
import { Box, Text, useInput, useStdin } from "ink";

import { isMouseSequence, parseMouseWheel } from "./mouse";
import { useActiveTheme, type Theme } from "./theme";

export interface ReportModalProps {
  title: string;
  text: string;
  width?: number;
  height?: number;
  theme?: Theme;
  onClose: () => void;
}

export function ReportModal(props: ReportModalProps): React.ReactElement {
  const { title, text, width = 100, height = 24, theme: themeProp, onClose } = props;
  const theme = useActiveTheme(themeProp);
  const lines = React.useMemo(() => text.split("\n"), [text]);
  const visibleCount = Math.max(1, height - 4);
  const maxOffset = Math.max(0, lines.length - visibleCount);
  const [offset, setOffset] = React.useState(0);
  const { stdin } = useStdin();

  React.useEffect(() => {
    setOffset(0);
  }, [title, text]);

  React.useEffect(() => {
    const onData = (data: Buffer): void => {
      const delta = parseMouseWheel(data.toString());
      if (delta !== 0) setOffset((value) => Math.max(0, Math.min(maxOffset, value - delta * 3)));
    };
    stdin.on("data", onData);
    return () => { stdin.off("data", onData); };
  }, [stdin, maxOffset]);

  useInput((input, key) => {
    if (isMouseSequence(input)) return;
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setOffset((value) => Math.max(0, value - 1));
      return;
    }
    if (key.downArrow) {
      setOffset((value) => Math.min(maxOffset, value + 1));
      return;
    }
    if (key.pageUp) {
      setOffset((value) => Math.max(0, value - visibleCount));
      return;
    }
    if (key.pageDown) {
      setOffset((value) => Math.min(maxOffset, value + visibleCount));
    }
  });

  const clamped = Math.min(offset, maxOffset);
  const visible = lines.slice(clamped, clamped + visibleCount);
  const contentWidth = Math.max(20, width - 4);
  const divider = "─".repeat(contentWidth);

  return (
    <Box flexDirection="column" width={contentWidth + 2} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={theme.accent} wrap="truncate">
          {title}
        </Text>
        <Text color={theme.muted} wrap="truncate">
          {lines.length === 0
            ? "empty"
            : `${clamped + 1}-${Math.min(clamped + visibleCount, lines.length)} of ${lines.length}`}
        </Text>
      </Box>
      <Text color={theme.border.passive} wrap="truncate">
        {divider}
      </Text>
      <Box flexDirection="column">
        {visible.length === 0 ? (
          <Text color={theme.muted}>No data.</Text>
        ) : (
          visible.map((line, index) => (
            <Text key={`${clamped + index}`} wrap="truncate">
              {line.length > 0 ? line : " "}
            </Text>
          ))
        )}
      </Box>
      <Text color={theme.border.passive} wrap="truncate">
        {divider}
      </Text>
      <Text color={theme.muted} wrap="truncate">
        Wheel / Up/Down scroll · PgUp/PgDn jump · Esc close
      </Text>
    </Box>
  );
}
