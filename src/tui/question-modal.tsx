import React from "react";
import { Box, Text, useInput } from "ink";

import type { QuestionAnswer, QuestionRequest } from "../tools/question";
import { isMouseSequence } from "./mouse";
import { getTheme, type Theme } from "./theme";

export interface PendingQuestion extends QuestionRequest {
  id: string;
}

export interface QuestionModalProps {
  request: PendingQuestion;
  onAnswer: (answer: QuestionAnswer) => void;
  theme?: Theme;
}

export function normalizeQuestionOptionLabel(label: string): string {
  const stripped = label.replace(/^\s*(?:\d+[.)]|[-*+])\s+/, "").trim();
  return stripped.length > 0 ? stripped : label.trim();
}

export function QuestionModal({
  request,
  onAnswer,
  theme = getTheme("tokyonight"),
}: QuestionModalProps): React.ReactElement {
  const [selected, setSelected] = React.useState(0);
  const [toggled, setToggled] = React.useState<Set<number>>(new Set());
  const [customMode, setCustomMode] = React.useState(false);
  const [customText, setCustomText] = React.useState("");
  const [notice, setNotice] = React.useState("");

  const customIndex = request.allow_custom ? request.options.length : -1;
  const total = request.options.length + (request.allow_custom ? 1 : 0);
  const clamped = Math.max(0, Math.min(total - 1, selected));
  const labels = request.options.map((option) => normalizeQuestionOptionLabel(option.label));

  useInput((input, key) => {
    if (isMouseSequence(input)) return;
    if (customMode) {
      if (key.escape) {
        setCustomMode(false);
        setNotice("");
        return;
      }
      if (key.return) {
        const custom = customText.trim();
        if (!custom) {
          setCustomMode(false);
          return;
        }
        const selectedLabels = request.multiple
          ? request.options.flatMap((option, index) =>
              toggled.has(index) ? [labels[index] ?? normalizeQuestionOptionLabel(option.label)] : [],
            )
          : [];
        onAnswer({ selected: selectedLabels, custom, cancelled: false });
        return;
      }
      if (key.backspace || key.delete || input === "\x7f" || input === "\b") {
        setCustomText((previous) => previous.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input.length > 0 && input >= " " && input !== "\x7f") {
        setCustomText((previous) => previous + input);
      }
      return;
    }

    if (key.escape) {
      onAnswer({ selected: [], cancelled: true });
      return;
    }
    if (key.upArrow) {
      setNotice("");
      setSelected((value) => (value > 0 ? value - 1 : total - 1));
      return;
    }
    if (key.downArrow) {
      setNotice("");
      setSelected((value) => (value < total - 1 ? value + 1 : 0));
      return;
    }
    if (/^[1-9]$/.test(input)) {
      const index = Number(input) - 1;
      const option = request.options[index];
      if (option) {
        setNotice("");
        setSelected(index);
        if (request.multiple) {
          setToggled((previous) => {
            const next = new Set(previous);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
          });
        } else {
          onAnswer({
            selected: [labels[index] ?? normalizeQuestionOptionLabel(option.label)],
            cancelled: false,
          });
        }
        return;
      }
      if (request.allow_custom && index === request.options.length) {
        setSelected(index);
        setNotice("");
        setCustomMode(true);
        setCustomText("");
        return;
      }
    }
    if (input === " ") {
      if (clamped === customIndex) {
        setCustomMode(true);
        setCustomText("");
        return;
      }
      if (request.multiple) {
        setToggled((previous) => {
          const next = new Set(previous);
          if (next.has(clamped)) next.delete(clamped);
          else next.add(clamped);
          return next;
        });
      }
      return;
    }
    if (key.return) {
      if (clamped === customIndex) {
        setCustomMode(true);
        setCustomText("");
        return;
      }
      if (request.multiple) {
        if (toggled.size === 0) {
          setNotice("Select at least one option with Space, or choose a custom answer.");
          return;
        }
        const selectedLabels = request.options.flatMap((option, index) =>
          toggled.has(index)
            ? [labels[index] ?? normalizeQuestionOptionLabel(option.label)]
            : [],
        );
        onAnswer({ selected: selectedLabels, cancelled: false });
        return;
      }
      const option = request.options[clamped];
      if (option) {
        onAnswer({
          selected: [labels[clamped] ?? normalizeQuestionOptionLabel(option.label)],
          cancelled: false,
        });
      }
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
      <Box justifyContent="space-between">
        <Text bold color={theme.accent}>
          {request.header ?? "QUESTION"}
        </Text>
        <Text color={theme.muted}>Esc cancel</Text>
      </Box>
      <Text color={theme.text}>{request.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {request.options.map((option, index) => {
          const active = index === clamped;
          const checked = toggled.has(index);
          return (
            <Text key={`${option.label}-${index}`}>
              <Text color={active ? theme.accent : theme.muted}>{active ? "❯ " : "  "}</Text>
              <Text color={theme.muted}>{`${index + 1}. `}</Text>
              {request.multiple ? (
                <Text color={active ? theme.accent : theme.muted}>{checked ? "[x] " : "[ ] "}</Text>
              ) : null}
              <Text bold={active} color={theme.text}>
                {labels[index] ?? normalizeQuestionOptionLabel(option.label)}
              </Text>
              {option.description ? <Text color={theme.muted}>  {option.description}</Text> : null}
            </Text>
          );
        })}
        {request.allow_custom ? (
          <Text>
            <Text color={clamped === customIndex ? theme.accent : theme.muted}>
              {clamped === customIndex ? "❯ " : "  "}
            </Text>
            <Text color={theme.muted}>{`${request.options.length + 1}. `}</Text>
            <Text color={theme.muted}>✎ Type a custom answer</Text>
          </Text>
        ) : null}
      </Box>
      {notice ? <Text color={theme.badge.running}>{notice}</Text> : null}
      {customMode ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.accent} bold>Custom answer:</Text>
          <Box>
            <Text color={theme.accent}>❯ </Text>
            <Text>{customText}</Text>
            <Text inverse color={theme.accent}> </Text>
          </Box>
          <Text color={theme.muted}>Enter submit · Esc back</Text>
        </Box>
      ) : (
        <Text color={theme.muted}>
          {request.multiple
            ? "Up/Down move · 1-8 toggle · Space toggle · Enter submit · Esc cancel"
            : "Up/Down move · 1-8 select · Enter select · Esc cancel"}
        </Text>
      )}
    </Box>
  );
}
