/**
 * Root AsyncAPI 3.1.0 document (the A2S / AsyncAPI Object).
 *
 * @see https://www.asyncapi.com/docs/reference/specification/v3.1.0#A2SObject
 */
export declare const asyncApiObjectSchema: import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
    asyncapi: import("@scalar/validation").StringSchema;
    id: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    info: import("@scalar/validation").ObjectSchema<{
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
    servers: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
    defaultContentType: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    channels: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
    operations: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").LazySchema<() => import("@scalar/validation").Schema>>>;
    components: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
}>, import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
    'x-original-aas-version': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-navigation': import("@scalar/validation").OptionalSchema<import("@scalar/validation").AnySchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-original-source-url': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-original-document-hash': import("@scalar/validation").StringSchema;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-is-dirty': import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-watch-mode': import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-registry-meta': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ObjectSchema<{
        namespace: import("@scalar/validation").StringSchema;
        slug: import("@scalar/validation").StringSchema;
        version: import("@scalar/validation").StringSchema;
        commitHash: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        conflictCheckedAgainstHash: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        hasConflict: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    }>>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-selected-server': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>]>]>;
//# sourceMappingURL=asyncapi-object.d.ts.map