/**
 * x-enum-varnames / x-enumNames
 *
 * Names the enum values. Must be in the same order as the enum values.
 *
 * @example
 * ```yaml
 * enum:
 *   - moon
 *   - asteroid
 *   - comet
 * x-enum-varnames:
 *   - Moon
 *   - Asteroid
 *   - Comet
 * ```
 */
export declare const XEnumVarNames: import("@scalar/validation").ObjectSchema<{
    'x-enum-varnames': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>>;
    'x-enumNames': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>>;
}>;
//# sourceMappingURL=x-enum-varnames.d.ts.map