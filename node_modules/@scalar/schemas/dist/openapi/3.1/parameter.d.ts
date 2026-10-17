export declare const parameter: import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
    name: import("@scalar/validation").StringSchema;
    in: import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").LiteralSchema<"query">, import("@scalar/validation").LiteralSchema<"header">, import("@scalar/validation").LiteralSchema<"path">, import("@scalar/validation").LiteralSchema<"cookie">]>;
    description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    required: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    deprecated: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    allowEmptyValue: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    allowReserved: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    style: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    explode: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    schema: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    example: import("@scalar/validation").OptionalSchema<import("@scalar/validation").AnySchema>;
    examples: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-global': import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-internal': import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-ignore': import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
}>]>, import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
    name: import("@scalar/validation").StringSchema;
    in: import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").LiteralSchema<"query">, import("@scalar/validation").LiteralSchema<"header">, import("@scalar/validation").LiteralSchema<"path">, import("@scalar/validation").LiteralSchema<"cookie">]>;
    description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    required: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    deprecated: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    allowEmptyValue: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    allowReserved: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    content: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").LazySchema<() => import("@scalar/validation").ObjectSchema<{
        schema: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
        example: import("@scalar/validation").OptionalSchema<import("@scalar/validation").AnySchema>;
        examples: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
        encoding: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").ObjectSchema<{
            contentType: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
            headers: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
        }>>>;
    }>>>>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-global': import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-internal': import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-ignore': import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
}>]>]>;
//# sourceMappingURL=parameter.d.ts.map