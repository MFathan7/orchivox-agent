/** Theme ids shared by the TUI and the config loader. Kept free of React imports. */
export const THEME_NAMES = [
  "tokyonight",
  "catppuccin",
  "gruvbox",
  "monochrome",
  "dracula",
  "ember",
  "paper",
] as const;

export type ThemeName = (typeof THEME_NAMES)[number];

/** Config values: a fixed preset or follow the detected terminal background. */
export const AUTO_THEME = "auto";
export type ThemeSelection = ThemeName | typeof AUTO_THEME;

export type TerminalAppearance = "dark" | "light" | "unknown";

export const DEFAULT_THEME: ThemeName = "tokyonight";
export const DEFAULT_LIGHT_THEME: ThemeName = "paper";

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEME_NAMES as readonly string[]).includes(value);
}

export function isThemeSelection(value: unknown): value is ThemeSelection {
  return value === AUTO_THEME || isThemeName(value);
}
