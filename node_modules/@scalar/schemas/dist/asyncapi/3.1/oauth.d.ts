export declare const asyncApiOAuthFlowObject: import("@scalar/validation").ObjectSchema<{
    authorizationUrl: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    tokenUrl: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    refreshUrl: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    availableScopes: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>>;
}>;
export declare const asyncApiOAuthFlowsObject: import("@scalar/validation").ObjectSchema<{
    implicit: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    password: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    clientCredentials: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    authorizationCode: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
}>;
//# sourceMappingURL=oauth.d.ts.map