/** Channel Object */
export declare const asyncApiChannelObject: import("@scalar/validation").LazySchema<() => import("@scalar/validation").ObjectSchema<{
    address: import("@scalar/validation").OptionalSchema<import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").StringSchema, import("@scalar/validation").NullableSchema]>>;
    messages: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").LazySchema<() => import("@scalar/validation").Schema>>>;
    title: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    summary: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    servers: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").Schema>>;
    parameters: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
    tags: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").Schema>>;
    externalDocs: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    bindings: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
}>>;
export declare const asyncApiChannelsObject: import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>;
//# sourceMappingURL=channel.d.ts.map