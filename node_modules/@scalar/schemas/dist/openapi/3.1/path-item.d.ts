export declare const pathItem: import("@scalar/validation").ObjectSchema<{
    $ref: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    summary: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    get: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    put: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    post: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    delete: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    patch: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    connect: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    options: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    head: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    trace: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    servers: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").ObjectSchema<{
        url: import("@scalar/validation").StringSchema;
        description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        variables: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").ObjectSchema<{
            enum: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>>;
            default: import("@scalar/validation").StringSchema;
            description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>>>;
    }>>>;
    parameters: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").Schema>>;
}>;
//# sourceMappingURL=path-item.d.ts.map