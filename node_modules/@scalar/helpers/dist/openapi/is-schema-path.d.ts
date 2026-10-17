/**
 * Determine whether a document path points inside a JSON Schema.
 *
 * OpenAPI 3.1 schemas are reachable through a handful of well-known keywords
 * (`schema`, `properties`, `items`, the composition keywords, …), through any
 * `*Schema` keyword (such as `contentSchema`), or directly under
 * `components/schemas`. Knowing this lets callers treat schema `$ref`s — which
 * may legally carry sibling keywords in JSON Schema 2020-12 — differently from
 * plain OpenAPI Reference Objects, where only `summary` and `description` are
 * allowed next to `$ref`.
 *
 * The path is walked left to right so that segments in user-defined key
 * positions (component names, path templates, header names, …) are never
 * mistaken for schema keywords. Bundled external documents are stored below
 * `x-ext/<hash>`; that wrapper is skipped before evaluating the embedded path.
 */
export declare const isSchemaPath: (path: readonly string[] | undefined) => boolean;
//# sourceMappingURL=is-schema-path.d.ts.map