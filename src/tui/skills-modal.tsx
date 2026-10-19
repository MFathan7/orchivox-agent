import React from "react";
import { Box, Text, useInput } from "ink";

import type { SkillDocument } from "../agent/skills";
import { truncateText } from "./format";
import { getTheme, type Theme } from "./theme";

export interface SkillsModalProps {
  skills: SkillDocument[];
  activeSkills?: string[];
  width?: number;
  theme?: Theme;
  onReload?: () => void;
  onClose: () => void;
}

export function SkillsModal({
  skills,
  activeSkills = [],
  width = 100,
  theme = getTheme("tokyonight"),
  onReload,
  onClose,
}: SkillsModalProps): React.ReactElement {
  const [selected, setSelected] = React.useState(0);
  const listWindow = 10;

  const clamped = Math.max(0, Math.min(skills.length - 1, selected));

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
      return;
    }
    if (key.downArrow) {
      setSelected((value) => (value < skills.length - 1 ? value + 1 : 0));
    }
  });

  const start = Math.max(0, Math.min(clamped - Math.floor(listWindow / 2), skills.length - listWindow));
  const visible = skills.slice(start, start + listWindow);
  const contentWidth = Math.max(20, width - 2);
  const nameWidth = Math.max(
    12,
    Math.min(24, skills.reduce((max, skill) => Math.max(max, skill.name.length), 0)),
  );

  return (
    <Box flexDirection="column" width={Math.max(20, width)} paddingX={1}>
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
        <Box flexDirection="column">
          {visible.map((skill, index) => {
            const actual = start + index;
            const isSelected = actual === clamped;
            const description = skill.description.replace(/\s+/g, " ").trim();
            const nameLabel = truncateText(skill.name, nameWidth).padEnd(nameWidth);
            const head = `${nameLabel} · ${skill.scope}`;
            const descriptionWidth = Math.max(8, contentWidth - 2 - head.length - 3);
            return (
              <Text key={skill.path} wrap="truncate">
                <Text color={isSelected ? theme.accent : theme.muted}>{isSelected ? "❯ " : "  "}</Text>
                <Text bold={isSelected} color={theme.text}>{nameLabel}</Text>
                <Text color={theme.muted}> · {skill.scope}</Text>
                {activeSkills.includes(skill.name) ? (
                  <Text color={theme.accent}> · active</Text>
                ) : null}
                {description ? (
                  <Text color={theme.muted}> · {truncateText(description, descriptionWidth)}</Text>
                ) : null}
              </Text>
            );
          })}
        </Box>
      )}

      <Text color={theme.muted}>Up/Down select · r reload · Esc close</Text>
    </Box>
  );
}
