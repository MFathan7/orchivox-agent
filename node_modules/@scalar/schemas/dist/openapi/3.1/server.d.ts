export declare const server: import("@scalar/validation").ObjectSchema<{
    url: import("@scalar/validation").StringSchema;
    description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    variables: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").ObjectSchema<{
        enum: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>>;
        default: import("@scalar/validation").StringSchema;
        description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    }>>>;
}>;
//# sourceMappingURL=server.d.ts.map