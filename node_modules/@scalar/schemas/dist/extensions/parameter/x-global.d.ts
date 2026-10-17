/**
 * OpenAPI extension used by the API client to determine if a parameter is global in scope
 * for the entire workspace. When set, this parameter is injected into every request automatically.
 *
 * @example
 * ```yaml
 * x-global: true
 * ```
 */
export declare const XGlobal: import("@scalar/validation").ObjectSchema<{
    'x-global': import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
}>;
//# sourceMappingURL=x-global.d.ts.map