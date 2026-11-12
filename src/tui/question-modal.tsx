import React from "react";
import { Box, Text, useInput } from "ink";

import type { QuestionAnswer, QuestionRequest } from "../tools/question";
import { isMouseSequence } from "./mouse";
import {
  clampCursor,
  deleteCharacterAfter,
  deleteCharacterBefore,
  deleteNextWord,
  deletePreviousWord,
  findNextWordEnd,
  findPreviousWordStart,
  insertTextAt,
  isWordBackspaceKey,
  isWordDeleteKey,
} from "./text-edit";
import { useActiveTheme, type Theme } from "./theme";

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

export interface CustomAnswerKey {
  ctrl?: boolean;
  meta?: boolean;
  backspace?: boolean;
  delete?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  home?: boolean;
  end?: boolean;
}

export interface CustomAnswerState {
  text: string;
  cursor: number;
}

/** Applies one editing key to the custom answer. Returns undefined for keys it does not handle. */
export function applyCustomAnswerEdit(
  state: CustomAnswerState,
  input: string,
  key: CustomAnswerKey,
): CustomAnswerState | undefined {
  const text = state.text;
  const cursor = clampCursor(text, state.cursor);
  const edited = (nextText: string, nextCursor: number): CustomAnswerState => ({
    text: nextText,
    cursor: nextCursor,
  });

  if (key.ctrl && key.leftArrow) return edited(text, findPreviousWordStart(text, cursor));
  if (key.ctrl && key.rightArrow) return edited(text, findNextWordEnd(text, cursor));
  if (key.leftArrow) return edited(text, Math.max(0, cursor - 1));
  if (key.rightArrow) return edited(text, Math.min(text.length, cursor + 1));
  if (key.home || (key.ctrl && input === "a") || input === "\x1b[H" || input === "\x1b[1~") {
    return edited(text, 0);
  }
  if (key.end || (key.ctrl && input === "e") || input === "\x1b[F" || input === "\x1b[4~") {
    return edited(text, text.length);
  }

  if (isWordDeleteKey(key, input)) {
    const result = deleteNextWord(text, cursor);
    return edited(result.nextText, result.nextCursor);
  }
  if (isWordBackspaceKey(key, input)) {
    const result = deletePreviousWord(text, cursor);
    return edited(result.nextText, result.nextCursor);
  }
  if (input === "\x1b[3~") {
    const result = deleteCharacterAfter(text, cursor);
    return edited(result.nextText, result.nextCursor);
  }
  if (key.backspace || key.delete || input === "\x7f" || input === "\b") {
    const result = deleteCharacterBefore(text, cursor);
    return edited(result.nextText, result.nextCursor);
  }
  if (!key.ctrl && !key.meta && input.length > 0 && input >= " " && input !== "\x7f") {
    const result = insertTextAt(text, cursor, input);
    return edited(result.nextText, result.nextCursor);
  }
  return undefined;
}

export function QuestionModal(props: QuestionModalProps): React.ReactElement {
  const { request, onAnswer, theme: themeProp } = props;
  const theme = useActiveTheme(themeProp);
  const [selected, setSelected] = React.useState(0);
  const [toggled, setToggled] = React.useState<Set<number>>(new Set());
  const [customMode, setCustomMode] = React.useState(
    request.options.length === 0 && request.allow_custom,
  );
  const [customText, setCustomText] = React.useState("");
  const [customCursor, setCustomCursor] = React.useState(0);
  const [notice, setNotice] = React.useState("");

  const customIndex = request.allow_custom ? request.options.length : -1;
  const total = request.options.length + (request.allow_custom ? 1 : 0);
  const clamped = Math.max(0, Math.min(total - 1, selected));
  const labels = request.options.map((option) => normalizeQuestionOptionLabel(option.label));

  const enterCustomMode = (): void => {
    setCustomMode(true);
    setCustomCursor(customText.length);
    setNotice("");
  };

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
      const next = applyCustomAnswerEdit({ text: customText, cursor: customCursor }, input, key);
      if (next) {
        setCustomText(next.text);
        setCustomCursor(next.cursor);
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
        enterCustomMode();
        return;
      }
    }
    if (input === " ") {
      if (clamped === customIndex) {
        enterCustomMode();
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
        enterCustomMode();
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
      borderStyle="single"
      borderColor={theme.border.passive}
      paddingX={1}
      marginY={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={theme.text}>
          {request.header ?? "QUESTION"}
        </Text>
        <Text color={theme.muted}>Esc cancel</Text>
      </Box>
      <Text color={theme.text}>{request.question}</Text>
      {request.mode_options ? (
        <Text color={theme.muted}>Answering switches the session mode.</Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {request.options.map((option, index) => {
          const active = index === clamped;
          const checked = toggled.has(index);
          return (
            <Text key={`${option.label}-${index}`}>
              <Text color={active ? theme.text : theme.muted}>{active ? "❯ " : "  "}</Text>
              <Text color={theme.muted}>{`${index + 1}. `}</Text>
              {request.multiple ? (
                <Text color={active ? theme.text : theme.muted}>{checked ? "[x] " : "[ ] "}</Text>
              ) : null}
              <Text bold={active} color={active ? theme.text : theme.muted}>
                {labels[index] ?? normalizeQuestionOptionLabel(option.label)}
              </Text>
              {option.description ? <Text color={theme.muted}>  {option.description}</Text> : null}
            </Text>
          );
        })}
        {request.allow_custom ? (
          <Text>
            <Text color={clamped === customIndex ? theme.text : theme.muted}>
              {clamped === customIndex ? "❯ " : "  "}
            </Text>
            <Text color={theme.muted}>{`${request.options.length + 1}. `}</Text>
            <Text color={theme.muted}>✎ Type a custom answer</Text>
          </Text>
        ) : null}
      </Box>
      {notice ? <Text color={theme.text}>{notice}</Text> : null}
      {customMode ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.text} bold>Custom answer:</Text>
          <Box>
            <Text color={theme.muted}>❯ </Text>
            <Text color={theme.text}>{customText.slice(0, customCursor)}</Text>
            <Text inverse color={theme.text}>{customText[customCursor] ?? " "}</Text>
            <Text color={theme.text}>{customText.slice(customCursor + 1)}</Text>
          </Box>
          <Text color={theme.muted}>Left/Right move · Home/End jump · Enter submit · Esc back</Text>
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
