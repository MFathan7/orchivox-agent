export declare const XTagGroup: import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
    name: import("@scalar/validation").StringSchema;
    tags: import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-order': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>>;
}>]>;
/**
 * x-tagGroups
 *
 * List of tags to include in this group.
 */
export declare const XTagGroups: import("@scalar/validation").ObjectSchema<{
    'x-tagGroups': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
        name: import("@scalar/validation").StringSchema;
        tags: import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>;
    }>, import("@scalar/validation").ObjectSchema<{
        'x-scalar-order': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>>;
    }>]>>>;
}>;
//# sourceMappingURL=x-tag-groups.d.ts.map