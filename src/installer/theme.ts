export interface InstallerPalette {
  accent: string;
  success: string;
  error: string;
  muted: string;
  text: string;
}

// Mirrors the tokyonight values in src/tui/theme.ts. The installer runs before
// the runtime exists, so it cannot import the React theme module.
export const INSTALLER_PALETTE: InstallerPalette = {
  accent: "#7aa2f7",
  success: "#9ece6a",
  error: "#f7768e",
  muted: "#7a86b8",
  text: "#c0caf5",
};

export interface StylerOptions {
  color?: boolean;
  trueColor?: boolean;
}

export interface Styler {
  accent(text: string): string;
  success(text: string): string;
  error(text: string): string;
  muted(text: string): string;
  text(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
}

const ANSI_256: Record<keyof InstallerPalette, number> = {
  accent: 111,
  success: 114,
  error: 204,
  muted: 103,
  text: 253,
};

const RESET = "\x1b[0m";

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function colorCode(name: keyof InstallerPalette, trueColor: boolean): string {
  if (trueColor) {
    const [red, green, blue] = hexToRgb(INSTALLER_PALETTE[name]);
    return `\x1b[38;2;${red};${green};${blue}m`;
  }
  return `\x1b[38;5;${ANSI_256[name]}m`;
}

export function createStyler(options: StylerOptions = {}): Styler {
  const color = options.color ?? true;
  const trueColor = options.trueColor ?? false;
  const paint = (name: keyof InstallerPalette) => (text: string) =>
    color ? `${colorCode(name, trueColor)}${text}${RESET}` : text;

  return {
    accent: paint("accent"),
    success: paint("success"),
    error: paint("error"),
    muted: paint("muted"),
    text: paint("text"),
    bold: (text) => (color ? `\x1b[1m${text}${RESET}` : text),
    dim: (text) => (color ? `\x1b[2m${text}${RESET}` : text),
  };
}

export function supportsTrueColor(env: NodeJS.ProcessEnv = process.env): boolean {
  return /truecolor|24bit/i.test(env.COLORTERM ?? "");
}
