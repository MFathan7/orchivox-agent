/**
 * True when the browser can run a view transition and the user has not asked for reduced motion.
 *
 * A missing `matchMedia` (older test environments) counts as "no preference", so the decision
 * rests on the View Transitions API alone there.
 */
export declare const supportsViewTransitions: () => boolean;
/**
 * Runs `update` inside a view transition when possible, otherwise runs it directly.
 *
 * Resolves once the transition has finished (or been skipped); it never rejects for a skipped
 * transition, because the DOM update has already happened either way.
 */
export declare const startViewTransition: (update: () => void | Promise<void>) => Promise<void>;
//# sourceMappingURL=start-view-transition.d.ts.map