import { type Schema } from '@scalar/validation';
/**
 * Wraps an inline schema so it may also be satisfied by an AsyncAPI Reference Object.
 *
 * Schemas in this folder use {@link recursiveRef} directly. Use {@link recursiveRef} only when
 * generating types for resolved or proxy documents (see `generate-types.ts`).
 */
export type MaybeRefFn = (inner: Schema) => Schema;
/**
 * AsyncAPI Reference Object (JSON Reference). Only `$ref` is defined; additional
 * properties SHALL be ignored per the specification.
 */
export declare const asyncApiReferenceObject: import("@scalar/validation").ObjectSchema<{
    $ref: import("@scalar/validation").StringSchema;
}>;
/**
 * Reference Object with resolved `$ref-value` and bundle extensions.
 *
 * Use when the specification allows only a Reference Object (not an inline object), for example
 * `operation.channel` or `channel.servers`.
 *
 * `$ref-value` is a resolved-document extension populated by the bundler/proxy at access time, so it
 * is optional here. If coercion required it, an unresolved `{ $ref }` would be filled with a default
 * instance of `schema` (for a security scheme, the first `type` literal — `userPassword`). Because the
 * magic proxy shares one target object between a `$ref-value` and the component it points at, that
 * synthetic default then leaks back over the real definition, clobbering its `type`.
 */
export declare const asyncApiResolvedReference: (schema: Schema) => Schema;
/** Inline object or Reference Object with resolved `$ref-value`. */
export declare const recursiveRef: (schema: Schema) => Schema;
//# sourceMappingURL=reference.d.ts.map