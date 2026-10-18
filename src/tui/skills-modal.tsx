import React from "react";
import { Box, Text, useInput } from "ink";

import type { SkillDocument } from "../agent/skills";
import { getTheme, type Theme } from "./theme";

export interface SkillsModalProps {
  skills: SkillDocument[];
  width?: number;
  theme?: Theme;
  onReload?: () => void;
  onClose: () => void;
}

export function SkillsModal({
  skills,
  width = 100,
  theme = getTheme("tokyonight"),
  onReload,
  onClose,
}: SkillsModalProps): React.ReactElement {
  const [selected, setSelected] = React.useState(0);
  const [previewOffset, setPreviewOffset] = React.useState(0);
  const listWindow = 8;
  const previewWindow = 14;

  const clamped = Math.max(0, Math.min(skills.length - 1, selected));
  const active = skills[clamped];
  const previewLines = active ? active.body.split("\n") : [];
  const maxOffset = Math.max(0, previewLines.length - previewWindow);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (input === "r") {
      onReload?.();
      return;
    }
    if (key.upArrow) {
      setSelected((value) => (value > 0 ? value - 1 : Math.max(0, skills.length - 1)));
      setPreviewOffset(0);
      return;
    }
    if (key.downArrow) {
      setSelected((value) => (value < skills.length - 1 ? value + 1 : 0));
      setPreviewOffset(0);
      return;
    }
    if (key.pageUp) {
      setPreviewOffset((value) => Math.max(0, value - previewWindow));
      return;
    }
    if (key.pageDown) {
      setPreviewOffset((value) => Math.min(maxOffset, value + previewWindow));
    }
  });

  const start = Math.max(0, Math.min(clamped - Math.floor(listWindow / 2), skills.length - listWindow));
  const visible = skills.slice(start, start + listWindow);
  const preview = previewLines.slice(previewOffset, previewOffset + previewWindow);
  const stacked = width < 90;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={theme.text}>Skills ({skills.length})</Text>
        <Text color={theme.muted}>r reload · Esc close</Text>
      </Box>

      {skills.length === 0 ? (
        <Box flexDirection="column">
          <Text color={theme.muted}>No skills installed.</Text>
          <Text color={theme.muted}>Add one at .agent/skills/&lt;name&gt;/SKILL.md or ~/.agents/skills/&lt;name&gt;/SKILL.md.</Text>
          <Text color={theme.muted}>Extra roots can be set with ORCHIVOX_SKILLS_PATH (colon-separated).</Text>
        </Box>
      ) : (
        <Box flexDirection={stacked ? "column" : "row"}>
          <Box width={stacked ? "100%" : "40%"} flexDirection="column" paddingRight={stacked ? 0 : 1}>
            <Text bold color={theme.modes.plan.primary}>Installed</Text>
            {visible.map((skill, index) => {
              const actual = start + index;
              const isSelected = actual === clamped;
              return (
                <Text key={skill.path}>
                  <Text color={isSelected ? theme.accent : theme.muted}>{isSelected ? "❯ " : "  "}</Text>
                  <Text bold={isSelected} color={theme.text}>{skill.name}</Text>
                  <Text color={theme.muted}> · {skill.scope}</Text>
                </Text>
              );
            })}
          </Box>

          {active ? (
            <Box width={stacked ? "100%" : "60%"} flexDirection="column">
              <Text bold color={theme.modes.plan.primary}>{active.name}</Text>
              <Text color={theme.text}>{active.description}</Text>
              {active.whenToUse ? <Text color={theme.muted}>When: {active.whenToUse}</Text> : null}
              <Text color={theme.muted}>{active.scope} · {active.path}</Text>
              <Text color={theme.border.passive}>{"─".repeat(stacked ? Math.max(20, width - 4) : 30)}</Text>
              {preview.map((line, index) => (
                <Text key={index} color={theme.text}>{line.length > 0 ? line : " "}</Text>
              ))}
              {previewLines.length > previewWindow ? (
                <Text color={theme.muted}>
                  lines {previewOffset + 1}-{Math.min(previewOffset + previewWindow, previewLines.length)} of {previewLines.length} · PageUp/PageDown
                </Text>
              ) : null}
            </Box>
          ) : null}
        </Box>
      )}

      <Text color={theme.muted}>Up/Down select · PageUp/PageDown preview · r reload · Esc close</Text>
    </Box>
  );
}
