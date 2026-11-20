import type { UiLayout } from "../types/ui-layout";

export type ComposerFrame = "box" | "rules" | "top-rule" | "none";
export type DiffStyle = "hashline" | "numbered" | "minimal";
export type ActivityIndicator = "shimmer" | "pulse" | "work" | "spinner";

export interface TranscriptStyle {
  userMarker: string;
  assistantMarker?: string;
  tools: "panel" | "timeline" | "inline";
  animateTools?: boolean;
  dense?: boolean;
  diff: DiffStyle;
}

interface LayoutPreset {
  label: string;
  description: string;
  divider?: boolean;
  contextInFooter?: boolean;
  composer: { frame: ComposerFrame; marker: string };
  transcript: TranscriptStyle;
  activity: ActivityIndicator;
}

export const LAYOUT_PRESETS: Record<UiLayout, LayoutPreset> = {
  orchivox: {
    label: "Orchivox",
    description: "Framed prompt and tool panels",
    divider: true,
    composer: { frame: "box", marker: "❯ " },
    transcript: { userMarker: "▌ ", tools: "panel", diff: "hashline" },
    activity: "shimmer",
  },
  reading: {
    label: "Claude Code",
    description: "Tool timeline, ruled prompt, animated status",
    composer: { frame: "rules", marker: "❯ " },
    transcript: { userMarker: "› ", assistantMarker: "• ", tools: "timeline", animateTools: false, diff: "minimal" },
    activity: "pulse",
  },
  review: {
    label: "Codex",
    description: "Animated work status and numbered diffs",
    composer: { frame: "top-rule", marker: "› " },
    transcript: { userMarker: "» ", assistantMarker: "• ", tools: "inline", animateTools: false, diff: "numbered" },
    activity: "work",
  },
  compact: {
    label: "Pi",
    description: "Inline tool progress and a context footer",
    contextInFooter: true,
    composer: { frame: "none", marker: "> " },
    transcript: { userMarker: "> ", tools: "inline", animateTools: false, dense: true, diff: "minimal" },
    activity: "spinner",
  },
};
