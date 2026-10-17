/**
 * Compare two semver-style version strings without pulling in a `semver`
 * dependency. We only need the small subset that supports `MAJOR.MINOR.PATCH`
 * with an optional pre-release tag, which is more than enough for the
 * "What's new" feature where versions look like `3.5.1` or `3.6.0-beta.1`.
 *
 * Returns a negative number when `a < b`, `0` when they are equal, and a
 * positive number when `a > b` - matching the contract of `Array.sort`.
 *
 * Pre-release versions (e.g. `1.0.0-rc.1`) are treated as **lower** than
 * the same version without a pre-release tag, per the semver spec. This is
 * intentional so users on a stable release do not see beta-only entries.
 *
 * Build metadata (anything after `+`) is stripped before comparison, also
 * per the semver spec.
 */
export declare const compareVersions: (a: string, b: string) => number;
/** Convenience wrapper: `true` when `a` is strictly less than `b`. */
export declare const isVersionLessThan: (a: string, b: string) => boolean;
/** Convenience wrapper: `true` when `a` is less than or equal to `b`. */
export declare const isVersionLessThanOrEqual: (a: string, b: string) => boolean;
//# sourceMappingURL=compare-versions.d.ts.map