/**
 * x-enumDescriptions / x-enum-descriptions
 *
 * Maps enum values to their descriptions. Each key should correspond to an enum value,
 * and the value is the description for that enum value.
 *
 * @example
 * ```yaml
 * x-enumDescriptions:
 *   missing_features: Missing features
 *   too_expensive: Too expensive
 *   unused: Unused
 *   other: Other
 * ```
 */
export declare const XEnumDescriptions: import("@scalar/validation").ObjectSchema<{
    'x-enumDescriptions': import("@scalar/validation").OptionalSchema<import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>, import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>]>>;
    'x-enum-descriptions': import("@scalar/validation").OptionalSchema<import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>, import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>]>>;
}>;
//# sourceMappingURL=x-enum-descriptions.d.ts.map