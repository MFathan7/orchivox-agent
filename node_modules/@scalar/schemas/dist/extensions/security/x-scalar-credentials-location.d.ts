/**
 * An OpenAPI extension to specify where OAuth2 credentials should be sent.
 *
 * @example
 * ```yaml
 * x-scalar-credentials-location: header
 * ```
 *
 * @example
 * ```yaml
 * x-scalar-credentials-location: body
 * ```
 */
export declare const XScalarCredentialsLocation: import("@scalar/validation").ObjectSchema<{
    'x-scalar-credentials-location': import("@scalar/validation").OptionalSchema<import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").LiteralSchema<"header">, import("@scalar/validation").LiteralSchema<"body">]>>;
}>;
//# sourceMappingURL=x-scalar-credentials-location.d.ts.map