import React, { createContext, useContext } from "react";

export type ThemeName = "tokyonight" | "catppuccin" | "gruvbox" | "monochrome";

export interface ModePalette {
  primary: string;
  secondary: string;
}

export interface Theme {
  name: ThemeName;
  background: string;
  text: string;
  muted: string;
  accent: string;
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
}

export const THEME_ORDER: ThemeName[] = ["tokyonight", "catppuccin", "gruvbox", "monochrome"];

export const THEMES: Record<ThemeName, Theme> = {
  tokyonight: {
    name: "tokyonight",
    background: "#1a1b26",
    text: "#c0caf5",
    muted: "#565f89",
    accent: "#7aa2f7",
    modes: {
      plan: { primary: "#7dcfff", secondary: "#bb9af7" },
      build: { primary: "#9ece6a", secondary: "#73daca" },
      ultrawork: { primary: "#e0af68", secondary: "#f7768e" },
    },
    diff: { added: "#9ece6a", removed: "#f7768e", hunkHeader: "#7aa2f7" },
    border: { active: "#7aa2f7", passive: "#3b4261" },
    badge: { running: "#e0af68", ok: "#9ece6a", error: "#f7768e", idle: "#565f89" },
    syntax: { keyword: "#bb9af7", string: "#9ece6a", comment: "#565f89", number: "#e0af68", type: "#7dcfff" },
  },
  catppuccin: {
    name: "catppuccin",
    background: "#1e1e2e",
    text: "#cdd6f4",
    muted: "#6c7086",
    accent: "#89b4fa",
    modes: {
      plan: { primary: "#89dceb", secondary: "#cba6f7" },
      build: { primary: "#a6e3a1", secondary: "#94e2d5" },
      ultrawork: { primary: "#f9e2af", secondary: "#f38ba8" },
    },
    diff: { added: "#a6e3a1", removed: "#f38ba8", hunkHeader: "#89b4fa" },
    border: { active: "#89b4fa", passive: "#45475a" },
    badge: { running: "#f9e2af", ok: "#a6e3a1", error: "#f38ba8", idle: "#6c7086" },
    syntax: { keyword: "#cba6f7", string: "#a6e3a1", comment: "#6c7086", number: "#fab387", type: "#89dceb" },
  },
  gruvbox: {
    name: "gruvbox",
    background: "#282828",
    text: "#ebdbb2",
    muted: "#928374",
    accent: "#83a598",
    modes: {
      plan: { primary: "#8ec07c", secondary: "#d3869b" },
      build: { primary: "#b8bb26", secondary: "#83a598" },
      ultrawork: { primary: "#fabd2f", secondary: "#fb4934" },
    },
    diff: { added: "#b8bb26", removed: "#fb4934", hunkHeader: "#83a598" },
    border: { active: "#83a598", passive: "#504945" },
    badge: { running: "#fabd2f", ok: "#b8bb26", error: "#fb4934", idle: "#928374" },
    syntax: { keyword: "#d3869b", string: "#b8bb26", comment: "#928374", number: "#fabd2f", type: "#8ec07c" },
  },
  monochrome: {
    name: "monochrome",
    background: "#111111",
    text: "#e6e6e6",
    muted: "#8a8a8a",
    accent: "#ffffff",
    modes: {
      plan: { primary: "#d0d0d0", secondary: "#9a9a9a" },
      build: { primary: "#c0c0c0", secondary: "#a8a8a8" },
      ultrawork: { primary: "#e0e0e0", secondary: "#b0b0b0" },
    },
    diff: { added: "#e0e0e0", removed: "#8a8a8a", hunkHeader: "#b0b0b0" },
    border: { active: "#ffffff", passive: "#4a4a4a" },
    badge: { running: "#d0d0d0", ok: "#e6e6e6", error: "#9a9a9a", idle: "#8a8a8a" },
    syntax: { keyword: "#d0d0d0", string: "#e6e6e6", comment: "#8a8a8a", number: "#c0c0c0", type: "#ffffff" },
  },
};

export function getTheme(name: ThemeName): Theme {
  return THEMES[name] ?? THEMES.tokyonight;
}

export class ThemeManager {
  private current: ThemeName;
  private readonly listeners = new Set<(theme: Theme) => void>();

  constructor(initial: ThemeName = "tokyonight") {
    this.current = THEMES[initial] ? initial : "tokyonight";
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

const ThemeContext = createContext<Theme>(THEMES.tokyonight);

export function ThemeProvider({
  theme = "tokyonight",
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
