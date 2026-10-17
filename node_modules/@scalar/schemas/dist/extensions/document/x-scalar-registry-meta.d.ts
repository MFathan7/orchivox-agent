export declare const XScalarRegistryMeta: import("@scalar/validation").ObjectSchema<{
    'x-scalar-registry-meta': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ObjectSchema<{
        namespace: import("@scalar/validation").StringSchema;
        slug: import("@scalar/validation").StringSchema;
        version: import("@scalar/validation").StringSchema;
        commitHash: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        conflictCheckedAgainstHash: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        hasConflict: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    }>>;
}>;
//# sourceMappingURL=x-scalar-registry-meta.d.ts.map