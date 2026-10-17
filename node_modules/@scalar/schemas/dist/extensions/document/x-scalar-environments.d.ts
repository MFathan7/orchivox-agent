/** A scalar environment variable */
export declare const XScalarEnvVar: import("@scalar/validation").ObjectSchema<{
    name: import("@scalar/validation").StringSchema;
    value: import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").ObjectSchema<{
        description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        default: import("@scalar/validation").StringSchema;
    }>, import("@scalar/validation").StringSchema]>;
}>;
/** An environment definition */
export declare const XScalarEnvironment: import("@scalar/validation").ObjectSchema<{
    description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    color: import("@scalar/validation").StringSchema;
    variables: import("@scalar/validation").ArraySchema<import("@scalar/validation").ObjectSchema<{
        name: import("@scalar/validation").StringSchema;
        value: import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").ObjectSchema<{
            description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
            default: import("@scalar/validation").StringSchema;
        }>, import("@scalar/validation").StringSchema]>;
    }>>;
}>;
export declare const XScalarEnvironments: import("@scalar/validation").ObjectSchema<{
    'x-scalar-environments': import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").ObjectSchema<{
        description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        color: import("@scalar/validation").StringSchema;
        variables: import("@scalar/validation").ArraySchema<import("@scalar/validation").ObjectSchema<{
            name: import("@scalar/validation").StringSchema;
            value: import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").ObjectSchema<{
                description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
                default: import("@scalar/validation").StringSchema;
            }>, import("@scalar/validation").StringSchema]>;
        }>>;
    }>>>;
}>;
//# sourceMappingURL=x-scalar-environments.d.ts.map