export declare const asyncApiInfoObject: import("@scalar/validation").ObjectSchema<{
    title: import("@scalar/validation").StringSchema;
    version: import("@scalar/validation").StringSchema;
    description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    termsOfService: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    contact: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ObjectSchema<{
        name: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        url: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        email: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    }>>;
    license: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    tags: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").Schema>>;
    externalDocs: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
}>;
//# sourceMappingURL=info.d.ts.map