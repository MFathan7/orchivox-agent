/**
 * Maps a comma-separated selector list to the theme modes it applies to.
 * Only **exact** `.light-mode` or `.dark-mode` selectors match (no compound selectors like `.light-mode .foo`).
 */
export declare const getColorModesFromSelectors: (text: string) => ("light" | "dark")[];
/**
 * Parses a single custom property value from the stylesheet into a normalized form:
 * - `#RRGGBB` / `#RRGGBBAA` (uppercase)
 * - `#RGB` short hex expanded to six digits
 * - `rgb()` / `rgba()` with comma-separated channels (lower input only)
 * - `var(--x)` / `var(--x, fallback)` returned as-is for a later resolve pass
 */
export declare const parseVariableValue: (value: string) => string | undefined;
/**
 * Recursively resolves a value if it is (or becomes) `var(--name)` against `variables`.
 * Missing names or non-var values are returned unchanged.
 */
export declare const resolveVariableValue: (value: string, variables: Record<string, string>) => string;
/**
 * Resolves `var(--*)` values in a flat map of custom properties in one pass.
 * Values that are not var references are copied through.
 */
export declare const resolveVariables: (variables: Record<string, string>) => Record<string, string>;
/**
 * Extracts CSS custom properties (variables) from a given CSS string
 * for .light-mode and .dark-mode selectors and returns an object
 * with 'light' and 'dark' keys containing the filtered variables.
 *
 * @param css - The CSS string to parse.
 * @returns An object with `light` and `dark` properties containing the extracted CSS variables.
 */
export declare const loadCssVariables: (css: string) => Promise<{
    light: Record<string, string>;
    dark: Record<string, string>;
}>;
//# sourceMappingURL=load-css-variables.d.ts.map