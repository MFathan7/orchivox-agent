import { type DarkLightMode } from '../theme/color-mode.js';
/**
 * The color mode stories render under unless the toolbar asks for another one.
 *
 * This follows the operating system, so Storybook opens in whichever mode the rest of the machine
 * is already in. It is resolved once when the preview loads rather than watched, since the toolbar
 * is there to override it either way.
 *
 * Snapshot tests never see this. They set the mode classes themselves for every screenshot they
 * take, light ones included, so the baselines do not depend on the preference of whatever machine
 * is running them.
 */
export declare const defaultColorMode: DarkLightMode;
/**
 * The toolbar controls every Scalar Storybook shares.
 *
 * These are plain object literals rather than Storybook's `GlobalTypes`, so this package does not
 * have to depend on Storybook for a type. Each preview assigns them into its own `Preview` object,
 * which is where they get type checked.
 */
export declare const scalarGlobalTypes: {
    theme: {
        description: string;
        toolbar: {
            title: string;
            icon: "paintbrush";
            items: {
                value: string;
                title: string;
            }[];
            dynamicTitle: boolean;
        };
    };
    colorMode: {
        description: string;
        toolbar: {
            title: string;
            icon: "contrast";
            items: ({
                value: string;
                title: string;
                icon: "sun";
            } | {
                value: string;
                title: string;
                icon: "moon";
            })[];
            dynamicTitle: boolean;
        };
    };
};
/**
 * The starting value for each global.
 *
 * Storybook drops any global that is not declared here, so this is also what lets a visual test
 * pick a theme or a color mode with `?globals=theme:laserwave;colorMode:dark` on the story URL.
 */
export declare const scalarInitialGlobals: {
    theme: "purple" | "alternate" | "default" | "moon" | "solarized" | "bluePlanet" | "deepSpace" | "saturn" | "kepler" | "elysiajs" | "fastify" | "mars" | "laserwave" | "rounded-none" | "rounded-full";
    colorMode: DarkLightMode;
};
/**
 * Applies the Scalar globals to the document.
 *
 * Call this from a decorator so it re-runs whenever the toolbar changes, rather than once when the
 * preview loads.
 */
export declare const applyScalarGlobals: (globals: Record<string, unknown>) => void;
//# sourceMappingURL=globals.d.ts.map