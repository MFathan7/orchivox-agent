import type { Schema } from './schema.js';
import type { Static } from './types.js';
/**
 * Memoizes `schema.schema()` per lazy schema so that recursive definitions
 * such as `lazy(() => object({ child: lazy(() => T) }))` resolve to the same
 * inner schema reference across calls. Without this, every traversal would
 * synthesize a fresh inner schema, defeating the `(value, schema)` cycle
 * cache and producing infinite recursion on self-referential values.
 *
 * The cache is supplied by the top-level `coerce` call so it never leaks
 * resolved schemas between unrelated invocations.
 */
type LazyCache = WeakMap<object, Schema>;
/**
 * Falls back to `any` when `S` widens all the way to the full `Schema` union and
 * returns the precise `Static<S>` otherwise. Computing `Static<Schema>` forces
 * TypeScript to expand every variant of the recursive `Schema` definition and
 * exhausts the depth limit, surfacing at call sites as
 * `TS2589: Type instantiation is excessively deep and possibly infinite`.
 * Degrading to `any` in that single case keeps the type tractable; callers that
 * pass a specific schema (for example an `intersection(...)` literal) still get
 * the precise static type.
 *
 * `[Schema] extends [S]` is wrapped in tuples to prevent distribution over union
 * members — we want a single check that the whole `Schema` union is assignable
 * to `S`, not a check that runs once per variant.
 */
type SafeStatic<S extends Schema> = [Schema] extends [S] ? any : Static<S>;
/**
 * Coerces an unknown value toward the static type implied by `schema`. Values that
 * pass {@link validate} for that branch are kept; otherwise primitives default to
 * `0`, `''`, or `false`, and arrays, records, and objects are built recursively.
 * Unions pick the best-matching branch; `evaluate` runs `expression` before the inner schema.
 *
 * @example
 * ```ts
 * import { coerce, number, object, string } from '@scalar/validation'
 *
 * coerce(number(), 42) // 42
 * coerce(number(), 'nope') // 0 — invalid number uses default
 * coerce(object({ id: number(), name: string() }), { id: '1', name: 'Ada' }) // { id: 0, name: 'Ada' }
 * ```
 *
 * The optional `cache` argument tracks visited object–schema pairs to stop infinite recursion
 * on cyclic graphs; callers normally omit it.
 */
export declare const coerce: <S extends Schema>(schema: S, value: unknown, cache?: WeakMap<object, Map<Schema, unknown>>, lazyCache?: LazyCache) => SafeStatic<S>;
export {};
//# sourceMappingURL=coerce.d.ts.map