export declare const info: import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
    title: import("@scalar/validation").StringSchema;
    version: import("@scalar/validation").StringSchema;
    summary: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    termsOfService: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    contact: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ObjectSchema<{
        name: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        url: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        email: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    }>>;
    license: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ObjectSchema<{
        name: import("@scalar/validation").StringSchema;
        identifier: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        url: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    }>>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-sdk-installation': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").ObjectSchema<{
        lang: import("@scalar/validation").StringSchema;
        description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        source: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    }>>>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-links': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").ObjectSchema<{
        name: import("@scalar/validation").StringSchema;
        url: import("@scalar/validation").StringSchema;
    }>>>;
}>]>;
//# sourceMappingURL=info.d.ts.map