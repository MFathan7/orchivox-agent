/**
 * An OpenAPI extension to set any additional body parameters for the OAuth token request.
 *
 * @example
 * ```yaml
 * x-scalar-security-body:
 *   audience: https://api.example.com
 *   resource: user-profile
 * ```
 */
export declare const XScalarSecurityBody: import("@scalar/validation").ObjectSchema<{
    'x-scalar-security-body': import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>>;
}>;
//# sourceMappingURL=x-scalar-security-body.d.ts.map