/**
 * A source is any potential document input used for API Reference
 * and API Client integrations. Sources may be specified in the configuration
 * or used independently. Some configurations may have multiple sources.
 */
export declare const sourceConfigurationSchema: import("@scalar/validation").ObjectSchema<{
    default: import("@scalar/validation").BooleanSchema;
    url: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    content: import("@scalar/validation").OptionalSchema<import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").StringSchema, import("@scalar/validation").NullableSchema, import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").AnySchema>, import("@scalar/validation").FunctionSchema<() => string | any>]>>;
    title: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    slug: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    spec: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ObjectSchema<{
        url: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        content: import("@scalar/validation").OptionalSchema<import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").StringSchema, import("@scalar/validation").NullableSchema, import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").AnySchema>, import("@scalar/validation").FunctionSchema<() => string | any>]>>;
    }>>;
    agent: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ObjectSchema<{
        key: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        disabled: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
        hideAddApi: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    }>>;
}>;
//# sourceMappingURL=source-configuration.d.ts.map