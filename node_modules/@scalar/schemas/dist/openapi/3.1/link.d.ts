export declare const link: import("@scalar/validation").ObjectSchema<{
    operationRef: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    operationId: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    parameters: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").AnySchema>>;
    requestBody: import("@scalar/validation").OptionalSchema<import("@scalar/validation").AnySchema>;
    description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    server: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ObjectSchema<{
        url: import("@scalar/validation").StringSchema;
        description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        variables: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").ObjectSchema<{
            enum: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>>;
            default: import("@scalar/validation").StringSchema;
            description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>>>;
    }>>;
}>;
//# sourceMappingURL=link.d.ts.map