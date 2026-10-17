/**
 * An OpenAPI extension to set any query parameters for the OAuth authorize request.
 *
 * @example
 * ```yaml
 * x-scalar-security-query:
 *   prompt: consent
 *   audience: scalar
 * ```
 */
export declare const XScalarSecurityQuery: import("@scalar/validation").ObjectSchema<{
    'x-scalar-security-query': import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>>;
}>;
//# sourceMappingURL=x-scalar-security-query.d.ts.map