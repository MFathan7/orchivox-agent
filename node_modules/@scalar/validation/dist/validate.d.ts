import type { Schema } from './schema.js';
/**
 * Validates that a given value matches the specified schema.
 *
 * The schema describes the expected structure/type of data.
 * Supported schema types include:
 * - 'any':         Accepts any value.
 * - 'unknown':     Accepts any value (generates `unknown` instead of `any` in types).
 * - 'function':    Only functions are valid (signature is not checked at runtime).
 * - 'number':      Only numbers are valid.
 * - 'string':      Only strings are valid.
 * - 'boolean':     Only booleans are valid.
 * - 'nullable':    Only `null` is valid.
 * - 'notDefined':  Only `undefined` is valid.
 * - 'array':       Array with all items validated recursively.
 * - 'record':      Object with string/number keys and values, checked recursively.
 * - 'object':      Plain object with fixed property keys, each validated recursively.
 * - 'union':       Accepts if value matches any of the listed schemas.
 * - 'optional':    Accepts `undefined` or a value matching the inner schema.
 * - 'intersection': Accepts if value matches every member schema (members are object schemas; value must be a plain object).
 * - 'literal':     Exact match with a literal value.
 * - 'lazy':        Delegates to the schema returned by the factory.
 * - 'evaluate':    Transforms value then validates against an inner schema.
 *
 * @example
 * ```ts
 * import { number, object, string, validate } from '@scalar/validation'
 *
 * const schema = object({ id: number(), name: string() })
 * validate(schema, { id: 1, name: 'Ada' }) // true
 * validate(schema, { id: 1, name: 2 }) // false
 * ```
 *
 * The optional `cache` argument tracks visited object–schema pairs to stop
 * infinite recursion on cyclic value graphs (for example a node whose child
 * points back at itself paired with a `lazy` schema). Callers normally omit it.
 *
 * If schema is `undefined`, validation fails.
 * Returns true if the value matches the schema, false otherwise.
 */
export declare const validate: (schema: Schema | undefined, value: unknown, cache?: WeakMap<object, Set<Schema>>) => boolean;
//# sourceMappingURL=validate.d.ts.map