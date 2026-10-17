/** A theme is a stylesheet, so a variant is either some CSS to apply or nothing at all. */
type ThemeVariant = {
    /** Label shown in the Storybook toolbar. */
    label: string;
    /** CSS to inject, or null to render the theme the stories already ship with. */
    css: string | null;
};
/** Every theme a story can be rendered under, whether from the toolbar or from a visual test. */
export declare const themeVariants: {
    'rounded-none': {
        readonly label: "Rounded None (0)";
        readonly css: "@layer scalar-theme { :root { --scalar-radius: 0px; } }";
    };
    'rounded-full': {
        readonly label: "Rounded Full (9999px)";
        readonly css: "@layer scalar-theme { :root { --scalar-radius: 9999px; } }";
    };
    purple: ThemeVariant;
    alternate: ThemeVariant;
    default: ThemeVariant;
    moon: ThemeVariant;
    solarized: ThemeVariant;
    bluePlanet: ThemeVariant;
    deepSpace: ThemeVariant;
    saturn: ThemeVariant;
    kepler: ThemeVariant;
    elysiajs: ThemeVariant;
    fastify: ThemeVariant;
    mars: ThemeVariant;
    laserwave: ThemeVariant;
};
export type ThemeVariantId = keyof typeof themeVariants;
/** The theme stories render under unless a story or a test asks for another one. */
export declare const defaultThemeVariant: ThemeVariantId;
/**
 * Applies a theme variant to the document.
 *
 * The preset CSS arrives wrapped in `@layer scalar-theme`, which outranks the `scalar-base` layer
 * the default preset is loaded into, so it wins on layer order rather than specificity. This is the
 * same mechanism the api reference uses to apply a theme at runtime.
 */
export declare const applyThemeVariant: (id: ThemeVariantId) => void;
export {};
//# sourceMappingURL=themes.d.ts.map