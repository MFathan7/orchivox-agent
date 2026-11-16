import React from "react";
import { Box, Text, useInput, useStdin } from "ink";

import { skillId, type SkillDiagnostic, type SkillDocument } from "../agent/skills";
import { skillInvocationLabel } from "../agent/skill-metadata";
import type { SkillDependencyReport } from "../agent/skill-dependencies";
import { isMouseSequence, parseMouseWheel } from "./mouse";
import { fitDisplayText, singleLine, wrapPreservingWhitespace } from "./text-wrap";
import { useActiveTheme, type Theme } from "./theme";

export interface SkillsModalProps {
  skills: SkillDocument[];
  diagnostics?: SkillDiagnostic[];
  dependencies?: SkillDependencyReport[];
  activeSkills?: string[];
  width?: number;
  height?: number;
  theme?: Theme;
  onReload?: () => void;
  onClose: () => void;
}

export function SkillsModal(props: SkillsModalProps): React.ReactElement {
  const { skills, diagnostics = [], activeSkills = [], onReload, onClose } = props;
  const theme = useActiveTheme(props.theme);
  const width = Math.max(4, props.width ?? 100);
  const height = Math.max(1, props.height ?? 18);
  const contentWidth = Math.max(1, width - 2);
  const headerRows = height >= 2 ? 1 : 0;
  const footerRows = height >= 7 ? 2 : height >= 3 ? 1 : 0;
  const bodyHeight = height - headerRows - footerRows;
  const [tab, setTab] = React.useState<"skills" | "issues">("skills");
  const [selected, setSelected] = React.useState(0);
  const [detail, setDetail] = React.useState(false);
  const [offset, setOffset] = React.useState(0);
  const count = tab === "skills" ? skills.length : diagnostics.length;
  const clamped = Math.max(0, Math.min(count - 1, selected));
  const skill = tab === "skills" ? skills[clamped] : undefined;
  const issue = tab === "issues" ? diagnostics[clamped] : undefined;
  const report = skill ? props.dependencies?.find((entry) => entry.id === skillId(skill)) : undefined;
  const details = skill ? [
    `Name: ${skill.name}`, `ID: ${skillId(skill)}`, `Scope: ${skill.scope}`,
    `File: ${skill.path}`, `Source: ${skill.sourceRoot ?? skill.path}`,
    `Invocation: ${skillInvocationLabel(skill)}`,
    "", skill.description,
    ...(skill.whenToUse ? [`When to use: ${skill.whenToUse}`] : []),
    ...(skill.compatibility ? [`Compatibility (informational): ${skill.compatibility}`] : []),
    ...(skill.license ? [`License: ${skill.license}`] : []),
    ...(skill.modelRole ? [`Model hint: ${skill.modelRole} (informational; routing unchanged)`] : []),
    ...(skill.interface?.display_name ? [`Display name: ${skill.interface.display_name}`] : []),
    ...(skill.interface?.short_description ? [`UI description: ${skill.interface.short_description}`] : []),
    ...(skill.sidecarPath ? [`Sidecar: ${skill.sidecarPath}`] : []),
    ...(skill.allowedTools ? [`Native tool restrictions: ${skill.allowedTools.join(", ") || "only always-allowed tools"}`] : []),
    ...(skill.portableAllowedTools ? [`Portable tool hints (no permissions): ${skill.portableAllowedTools.join(", ")}`] : []),
    ...(skill.metadataError ? [`Metadata error: ${skill.metadataError}`] : []),
    ...(skill.metadataNotices ?? []).map((entry) => `${entry.severity === "error" ? "Error" : "Warning"}: ${entry.message}`),
    ...(report?.checks ?? []).map((entry) => `${entry.type} ${entry.value}: ${entry.status}. ${entry.message}`),
    ...(!report ? (skill.dependencies ?? []).map((entry) => `${entry.type} ${entry.value}: not checked.`) : []),
  ] : issue ? [
    `${issue.severity === "error" ? "Error" : "Warning"}: ${issue.kind}`,
    issue.message, `File: ${issue.path}`,
    ...(issue.ids ?? []).flatMap((id, index) => [`ID: ${id}`, `File: ${issue.paths?.[index] ?? issue.path}`]),
  ] : [];
  const detailLines = details.flatMap((line) => wrapPreservingWhitespace(line, contentWidth));
  const maxOffset = Math.max(0, detailLines.length - bodyHeight);
  const detailOffset = Math.min(offset, maxOffset);
  const previewRows = bodyHeight >= 4 && count > 0 ? 2 : 0;
  const visibleCount = Math.max(1, bodyHeight - previewRows);
  const start = Math.max(0, Math.min(clamped - Math.floor(visibleCount / 2), count - visibleCount));
  const line = (value: string) => fitDisplayText(singleLine(value), contentWidth);
  const move = React.useCallback((delta: number) => {
    if (detail) setOffset((value) => Math.max(0, Math.min(maxOffset, Math.min(value, maxOffset) + delta)));
    else setSelected((value) => Math.max(0, Math.min(count - 1, Math.min(value, count - 1) + delta)));
  }, [detail, maxOffset, count]);
  const { stdin } = useStdin();
  React.useEffect(() => {
    const listener = (data: Buffer | string) => {
      const delta = parseMouseWheel(String(data));
      if (delta) move(-delta * 3);
    };
    stdin.on("data", listener);
    return () => { stdin.off("data", listener); };
  }, [stdin, move]);
  useInput((input, key) => {
    if (isMouseSequence(input)) return;
    if (key.escape) {
      if (detail) { setDetail(false); setOffset(0); }
      else onClose();
    } else if (input === "r" && onReload) {
      setDetail(false); setOffset(0); onReload();
    } else if (key.tab) {
      setTab((current) => current === "skills" ? "issues" : "skills");
      setSelected(0); setDetail(false); setOffset(0);
    } else if (key.return && count > 0) {
      setDetail(true); setOffset(0);
    } else if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-(detail ? bodyHeight : visibleCount));
    else if (key.pageDown) move(detail ? bodyHeight : visibleCount);
  });
  const empty = tab === "skills"
    ? "No skills installed. Add .agents/skills/<name>/SKILL.md or .agent/skills/<name>/SKILL.md. Global skills: ~/.agents/skills. Extra roots: ORCHIVOX_SKILLS_PATH."
    : "No skill issues.";
  const rows = tab === "skills"
    ? skills.slice(start, start + visibleCount).map((entry) => {
      const state = entry.enabled === false || entry.metadataError || entry.hidden || entry.autoinvoke === false
        ? skillInvocationLabel(entry) : "";
      const needsSetup = props.dependencies?.find((item) => item.id === skillId(entry))?.checks.some((check) => check.status !== "available");
      const status = state || (needsSetup ? "check dependencies" : "");
      return {
        key: skillId(entry), label: `${status ? `${status} · ` : ""}${skillId(entry)} · ${entry.scope}${activeSkills.includes(skillId(entry)) ? " · used" : ""}`,
      };
    })
    : diagnostics.slice(start, start + visibleCount).map((entry, index) => ({
      key: `${start + index}-${entry.path}`, label: `${entry.severity === "error" ? "Error" : "Warning"} · ${entry.kind}: ${entry.skillName ?? entry.message}`,
    }));

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} overflow="hidden">
      {headerRows > 0 ? <Text bold color={theme.text} wrap="truncate">{line(detail
        ? `${tab === "skills" ? "Skill" : "Issue"} details · ${detailOffset + 1}-${Math.min(detailLines.length, detailOffset + bodyHeight)}/${detailLines.length}`
        : `${tab === "skills" ? "[Skills" : "Skills"} (${skills.length})${tab === "skills" ? "]" : ""} · ${tab === "issues" ? "[Issues" : "Issues"} (${diagnostics.length})${tab === "issues" ? "]" : ""}`)}</Text> : null}
      <Box flexDirection="column" height={bodyHeight} overflow="hidden">
        {detail && detailLines.length > 0
          ? detailLines.slice(detailOffset, detailOffset + bodyHeight).map((text, index) => (
            <Text key={detailOffset + index} color={theme.text} wrap="truncate">{text || " "}</Text>
          ))
          : count === 0
            ? wrapPreservingWhitespace(empty, contentWidth).slice(0, bodyHeight).map((text, index) => (
              <Text key={index} color={theme.muted} wrap="truncate">{text}</Text>
            ))
            : <>
              <Box flexDirection="column" height={visibleCount}>
                {rows.map((row, index) => <Text key={row.key} color={start + index === clamped ? theme.accent : theme.text}
                  bold={start + index === clamped} wrap="truncate">{line(`${start + index === clamped ? "❯" : " "} ${row.label}`)}</Text>)}
              </Box>
              {previewRows > 0 ? <>
                <Text color={theme.muted} wrap="truncate">{line(`File: ${skill?.path ?? issue?.path ?? ""}`)}</Text>
                <Text color={theme.muted} wrap="truncate">{line(`${clamped + 1}/${count} · ${skill?.description ?? issue?.message ?? ""}`)}</Text>
              </> : null}
            </>}
      </Box>
      {footerRows === 2 ? <Text color={theme.muted} wrap="truncate">{line(detail ? "↑/↓ Wheel · PgUp/PgDn scroll" : "↑/↓ Wheel · Enter details · Tab switch")}</Text> : null}
      {footerRows > 0 ? <Text color={theme.muted} wrap="truncate">{line(`${footerRows === 1 ? "Tab · Enter · " : ""}${onReload ? "r reload · " : ""}Esc ${detail ? "back" : "close"}`)}</Text> : null}
    </Box>
  );
}
