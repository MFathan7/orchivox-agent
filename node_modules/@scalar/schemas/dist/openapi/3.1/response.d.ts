export declare const response: import("@scalar/validation").ObjectSchema<{
    description: import("@scalar/validation").StringSchema;
    headers: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
    content: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").LazySchema<() => import("@scalar/validation").ObjectSchema<{
        schema: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
        example: import("@scalar/validation").OptionalSchema<import("@scalar/validation").AnySchema>;
        examples: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
        encoding: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").ObjectSchema<{
            contentType: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
            headers: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
        }>>>;
    }>>>>;
    links: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
}>;
export declare const responsesObject: import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>;
//# sourceMappingURL=response.d.ts.map