import { type Schema } from '@scalar/validation';
/**
 * Wraps a JSON Schema so it may also be satisfied by a Reference Object (no resolved `$ref-value`).
 *
 * Use for `components.schemas` and schema composition (`allOf`, `properties`, `items`, and similar)
 * where references follow JSON Schema / OpenAPI schema rules only.
 */
export declare const normalRef: (inner: Schema) => Schema;
/**
 * Inline object or Reference Object with resolved `$ref-value` and bundle extensions.
 *
 * Schemas in this folder use {@link recursiveRef} directly. Use {@link recursiveRef} when generating
 * types for resolved or proxy documents (see `generate-types.ts`).
 */
export declare const recursiveRef: (inner: Schema) => Schema;
//# sourceMappingURL=reference.d.ts.map