/**
 * Validates that a key is safe to use and does not pose a prototype pollution risk.
 * Throws an error if a dangerous key is detected.
 *
 * @param key - The key to validate
 * @param context - Optional context string to help identify where the validation failed
 * @throws {Error} If the key matches a known prototype pollution vector
 *
 * @example
 * ```ts
 * preventPollution('__proto__') // throws Error
 * preventPollution('safeName') // passes
 * preventPollution('constructor', 'operation update') // throws Error with context
 * ```
 */
export declare const preventPollution: (key: string, context?: string) => void;
/**
 * Checks whether a key poses a prototype pollution risk, without throwing.
 *
 * Use this when a dangerous key should be filtered out rather than rejected, for example when
 * walking the keys of an untrusted document. Use `preventPollution` when the key should be
 * rejected outright.
 *
 * @param key - The key to check
 * @returns true when the key matches a known prototype pollution vector, false otherwise
 *
 * @example
 * ```ts
 * isPollutionKey('__proto__') // true
 * isPollutionKey('safeName') // false
 * ```
 */
export declare const isPollutionKey: (key: string) => boolean;
//# sourceMappingURL=prevent-pollution.d.ts.map