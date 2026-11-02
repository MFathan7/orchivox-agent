import React, { createContext, useContext } from "react";

import {
  AUTO_THEME,
  DEFAULT_LIGHT_THEME,
  DEFAULT_THEME,
  THEME_NAMES,
  isThemeName,
  isThemeSelection,
  type TerminalAppearance,
  type ThemeName,
  type ThemeSelection,
} from "../types/theme";

export {
  AUTO_THEME,
  DEFAULT_LIGHT_THEME,
  DEFAULT_THEME,
  THEME_NAMES,
  isThemeName,
  isThemeSelection,
};
export type { TerminalAppearance, ThemeName, ThemeSelection };

export interface ModePalette {
  primary: string;
  secondary: string;
}

export interface ThemeStatusPalette {
  success: string;
  warning: string;
  error: string;
  info: string;
}

export interface Theme {
  name: ThemeName;
  /** Human label for menus and notices. */
  label: string;
  /** The terminal background this preset expects. */
  appearance: "dark" | "light";
  description: string;
  background: string;
  text: string;
  muted: string;
  accent: string;
  /** Foreground for the selected item in a list. */
  selection: string;
  /** Border color for the focused interactive surface. */
  focus: string;
  /** Semantic colors. Never derive status from a mode color. */
  status: ThemeStatusPalette;
  modes: {
    plan: ModePalette;
    build: ModePalette;
    ultrawork: ModePalette;
  };
  diff: {
    added: string;
    removed: string;
    hunkHeader: string;
  };
  border: {
    active: string;
    passive: string;
  };
  badge: {
    running: string;
    ok: string;
    error: string;
    idle: string;
  };
  syntax: {
    keyword: string;
    string: string;
    comment: string;
    number: string;
    type: string;
  };
  code: {
    background: string;
    border: string;
  };
  tool: {
    background: string;
    border: string;
  };
}

export const THEME_ORDER = THEME_NAMES;

export const THEMES: Record<ThemeName, Theme> = {
  tokyonight: {
    name: "tokyonight",
    label: "Tokyo Night",
    appearance: "dark",
    description: "Cool blue on deep navy",
    background: "#1a1b26",
    text: "#c0caf5",
    muted: "#7a86b8",
    accent: "#7aa2f7",
    selection: "#7aa2f7",
    focus: "#7aa2f7",
    status: { success: "#9ece6a", warning: "#e0af68", error: "#f7768e", info: "#7dcfff" },
    modes: {
      plan: { primary: "#7dcfff", secondary: "#bb9af7" },
      build: { primary: "#9ece6a", secondary: "#73daca" },
      ultrawork: { primary: "#e0af68", secondary: "#f7768e" },
    },
    diff: { added: "#9ece6a", removed: "#f7768e", hunkHeader: "#7aa2f7" },
    border: { active: "#7aa2f7", passive: "#3b4261" },
    badge: { running: "#e0af68", ok: "#9ece6a", error: "#f7768e", idle: "#6b76a8" },
    syntax: { keyword: "#bb9af7", string: "#9ece6a", comment: "#8b96c9", number: "#e0af68", type: "#7dcfff" },
    code: { background: "#24283b", border: "#3b4261" },
    tool: { background: "#1f2335", border: "#3b4261" },
  },
  catppuccin: {
    name: "catppuccin",
    label: "Catppuccin",
    appearance: "dark",
    description: "Soft pastel on mocha",
    background: "#1e1e2e",
    text: "#cdd6f4",
    muted: "#9399b2",
    accent: "#89b4fa",
    selection: "#89b4fa",
    focus: "#89b4fa",
    status: { success: "#a6e3a1", warning: "#f9e2af", error: "#f38ba8", info: "#89dceb" },
    modes: {
      plan: { primary: "#89dceb", secondary: "#cba6f7" },
      build: { primary: "#a6e3a1", secondary: "#94e2d5" },
      ultrawork: { primary: "#f9e2af", secondary: "#f38ba8" },
    },
    diff: { added: "#a6e3a1", removed: "#f38ba8", hunkHeader: "#89b4fa" },
    border: { active: "#89b4fa", passive: "#45475a" },
    badge: { running: "#f9e2af", ok: "#a6e3a1", error: "#f38ba8", idle: "#6c7086" },
    syntax: { keyword: "#cba6f7", string: "#a6e3a1", comment: "#a0a6c0", number: "#fab387", type: "#89dceb" },
    code: { background: "#313244", border: "#45475a" },
    tool: { background: "#292c3c", border: "#45475a" },
  },
  gruvbox: {
    name: "gruvbox",
    label: "Gruvbox",
    appearance: "dark",
    description: "Warm earth tones",
    background: "#282828",
    text: "#ebdbb2",
    muted: "#a89984",
    accent: "#83a598",
    selection: "#83a598",
    focus: "#83a598",
    status: { success: "#b8bb26", warning: "#fabd2f", error: "#fc5c4d", info: "#8ec07c" },
    modes: {
      plan: { primary: "#8ec07c", secondary: "#d3869b" },
      build: { primary: "#b8bb26", secondary: "#83a598" },
      ultrawork: { primary: "#fabd2f", secondary: "#fc5c4d" },
    },
    diff: { added: "#b8bb26", removed: "#fc5c4d", hunkHeader: "#83a598" },
    border: { active: "#83a598", passive: "#504945" },
    badge: { running: "#fabd2f", ok: "#b8bb26", error: "#fc5c4d", idle: "#928374" },
    syntax: { keyword: "#e39aad", string: "#b8bb26", comment: "#c0b09a", number: "#fabd2f", type: "#8ec07c" },
    code: { background: "#3c3836", border: "#504945" },
    tool: { background: "#32302f", border: "#504945" },
  },
  monochrome: {
    name: "monochrome",
    label: "Monochrome",
    appearance: "dark",
    description: "Neutral greys, no hue",
    background: "#111111",
    text: "#e6e6e6",
    muted: "#8a8a8a",
    accent: "#ffffff",
    selection: "#ffffff",
    focus: "#ffffff",
    status: { success: "#c0c0c0", warning: "#d0d0d0", error: "#9a9a9a", info: "#d0d0d0" },
    modes: {
      plan: { primary: "#d0d0d0", secondary: "#9a9a9a" },
      build: { primary: "#c0c0c0", secondary: "#a8a8a8" },
      ultrawork: { primary: "#e0e0e0", secondary: "#b0b0b0" },
    },
    diff: { added: "#e0e0e0", removed: "#8a8a8a", hunkHeader: "#b0b0b0" },
    border: { active: "#ffffff", passive: "#4a4a4a" },
    badge: { running: "#d0d0d0", ok: "#e6e6e6", error: "#9a9a9a", idle: "#8a8a8a" },
    syntax: { keyword: "#d0d0d0", string: "#e6e6e6", comment: "#8a8a8a", number: "#c0c0c0", type: "#ffffff" },
    code: { background: "#1f1f1f", border: "#4a4a4a" },
    tool: { background: "#181818", border: "#4a4a4a" },
  },
  dracula: {
    name: "dracula",
    label: "Dracula",
    appearance: "dark",
    description: "Violet accent on charcoal",
    background: "#282a36",
    text: "#f8f8f2",
    muted: "#a4b1d6",
    accent: "#bd93f9",
    selection: "#bd93f9",
    focus: "#bd93f9",
    status: { success: "#50fa7b", warning: "#ffb86c", error: "#ff5555", info: "#8be9fd" },
    modes: {
      plan: { primary: "#8be9fd", secondary: "#bd93f9" },
      build: { primary: "#50fa7b", secondary: "#8be9fd" },
      ultrawork: { primary: "#ffb86c", secondary: "#ff79c6" },
    },
    diff: { added: "#50fa7b", removed: "#ff5555", hunkHeader: "#8be9fd" },
    border: { active: "#bd93f9", passive: "#4f5268" },
    badge: { running: "#ffb86c", ok: "#50fa7b", error: "#ff5555", idle: "#9aa8d0" },
    syntax: { keyword: "#ff79c6", string: "#f1fa8c", comment: "#a4b1d6", number: "#bd93f9", type: "#8be9fd" },
    code: { background: "#21222c", border: "#44475a" },
    tool: { background: "#21222c", border: "#44475a" },
  },
  ember: {
    name: "ember",
    label: "Ember",
    appearance: "dark",
    description: "Warm ember on stone",
    background: "#1c1815",
    text: "#f4ede5",
    muted: "#b9a897",
    accent: "#f97316",
    selection: "#f97316",
    focus: "#f97316",
    status: { success: "#86efac", warning: "#facc15", error: "#fca5a5", info: "#67e8f9" },
    modes: {
      plan: { primary: "#67e8f9", secondary: "#a5b4fc" },
      build: { primary: "#fb923c", secondary: "#facc15" },
      ultrawork: { primary: "#facc15", secondary: "#fca5a5" },
    },
    diff: { added: "#86efac", removed: "#fca5a5", hunkHeader: "#fdba74" },
    border: { active: "#f97316", passive: "#4a3f37" },
    badge: { running: "#facc15", ok: "#86efac", error: "#fca5a5", idle: "#c9b8a6" },
    syntax: { keyword: "#f0abfc", string: "#86efac", comment: "#b9a897", number: "#fdba74", type: "#67e8f9" },
    code: { background: "#241f1b", border: "#4a3f37" },
    tool: { background: "#241f1b", border: "#4a3f37" },
  },
  paper: {
    name: "paper",
    label: "Paper",
    appearance: "light",
    description: "Ink on warm paper",
    background: "#f7f6f2",
    text: "#1b1f24",
    muted: "#5a6472",
    accent: "#0f766e",
    selection: "#0f766e",
    focus: "#0f766e",
    status: { success: "#15803d", warning: "#b45309", error: "#b91c1c", info: "#0e7490" },
    modes: {
      plan: { primary: "#0e7490", secondary: "#155e75" },
      build: { primary: "#15803d", secondary: "#166534" },
      ultrawork: { primary: "#b45309", secondary: "#b91c1c" },
    },
    diff: { added: "#15803d", removed: "#b91c1c", hunkHeader: "#1d4ed8" },
    border: { active: "#0f766e", passive: "#c9c5bd" },
    badge: { running: "#b45309", ok: "#15803d", error: "#b91c1c", idle: "#6b7280" },
    syntax: { keyword: "#7c3aed", string: "#166534", comment: "#5a6472", number: "#92400e", type: "#155e75" },
    code: { background: "#ece9e2", border: "#d8d4cb" },
    tool: { background: "#f0ede7", border: "#d8d4cb" },
  },
};

export function getTheme(name: ThemeName): Theme {
  return THEMES[name] ?? THEMES[DEFAULT_THEME];
}

export function themeLabel(name: ThemeName): string {
  return THEMES[name]?.label ?? THEMES[DEFAULT_THEME].label;
}

/** Resolves a theme name from config or a slash command without throwing. */
export function resolveThemeName(value: string | undefined): ThemeName {
  return isThemeName(value) ? value : DEFAULT_THEME;
}

/** Turns any config or command value into auto or a known preset. */
export function normalizeThemeSelection(value: string | undefined): ThemeSelection {
  return isThemeSelection(value) ? value : AUTO_THEME;
}

/** Auto follows the terminal background; an explicit preset wins. */
export function resolveThemeSelection(
  selection: ThemeSelection,
  appearance: TerminalAppearance,
): ThemeName {
  if (selection !== AUTO_THEME) return selection;
  return appearance === "light" ? DEFAULT_LIGHT_THEME : DEFAULT_THEME;
}

export function themeSelectionLabel(selection: ThemeSelection, resolved: ThemeName): string {
  return selection === AUTO_THEME ? `Auto (${themeLabel(resolved)})` : themeLabel(selection);
}

/** A preset can still be chosen on the wrong background, but the user is told. */
export function themeMismatchWarning(
  theme: ThemeName,
  appearance: TerminalAppearance,
): string | undefined {
  if (themeFitsAppearance(theme, appearance)) return undefined;
  const expected = THEMES[theme].appearance;
  const background =
    appearance === "unknown"
      ? "the terminal background is unknown"
      : `this terminal looks ${appearance}`;
  return `${THEMES[theme].label} needs a ${expected} terminal; ${background}.`;
}

/**
 * Unknown terminal backgrounds keep the safe dark assumption. A light preset
 * cannot be selected until the terminal reports a light background or the
 * ORCHIVOX_APPEARANCE override says so.
 */
export function themeFitsAppearance(
  theme: ThemeName,
  appearance: TerminalAppearance,
): boolean {
  const expected = THEMES[theme].appearance;
  return appearance === "unknown" ? expected === "dark" : expected === appearance;
}

export interface ThemeResolution {
  selection: ThemeSelection;
  theme: ThemeName;
  warning?: string;
}

/**
 * Resolves a request into something readable. A preset that cannot be read on
 * this terminal falls back to auto instead of rendering invisible text.
 */
export function resolveThemeChoice(
  selection: ThemeSelection,
  appearance: TerminalAppearance,
): ThemeResolution {
  if (selection === AUTO_THEME) {
    return { selection, theme: resolveThemeSelection(selection, appearance) };
  }
  if (themeFitsAppearance(selection, appearance)) {
    return { selection, theme: selection };
  }
  const fallback = resolveThemeSelection(AUTO_THEME, appearance);
  const background =
    appearance === "unknown"
      ? "the terminal background is unknown"
      : `this terminal looks ${appearance}`;
  return {
    selection: AUTO_THEME,
    theme: fallback,
    warning: `${THEMES[selection].label} needs a ${THEMES[selection].appearance} terminal; ${background}. Using ${THEMES[fallback].label}.`,
  };
}

export class ThemeManager {
  private current: ThemeName;
  private readonly listeners = new Set<(theme: Theme) => void>();

  constructor(initial: ThemeName = DEFAULT_THEME) {
    this.current = initial;
  }

  get name(): ThemeName {
    return this.current;
  }

  get theme(): Theme {
    return getTheme(this.current);
  }

  set(name: ThemeName): void {
    if (!THEMES[name]) return;
    this.current = name;
    for (const listener of this.listeners) listener(this.theme);
  }

  cycle(): ThemeName {
    const index = THEME_ORDER.indexOf(this.current);
    const next = THEME_ORDER[(index + 1) % THEME_ORDER.length];
    this.set(next);
    return this.current;
  }

  subscribe(listener: (theme: Theme) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const ThemeContext = createContext<Theme>(THEMES[DEFAULT_THEME]);

export function ThemeProvider({
  theme = DEFAULT_THEME,
  children,
}: {
  theme?: ThemeName | Theme;
  children: React.ReactNode;
}): React.ReactElement {
  const activeTheme = typeof theme === "string" ? getTheme(theme) : theme;
  return React.createElement(ThemeContext.Provider, { value: activeTheme }, children);
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/**
 * Component-level resolver. A caller that passes the theme wins; otherwise the
 * nearest provider supplies it, so a new preset never falls back to Tokyo Night
 * silently.
 */
export function useActiveTheme(theme?: Theme): Theme {
  const contextTheme = useTheme();
  return theme ?? contextTheme;
}
