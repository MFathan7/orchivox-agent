export declare const securityScheme: import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").ObjectSchema<{
    type: import("@scalar/validation").LiteralSchema<"apiKey">;
    name: import("@scalar/validation").StringSchema;
    in: import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").LiteralSchema<"query">, import("@scalar/validation").LiteralSchema<"header">, import("@scalar/validation").LiteralSchema<"cookie">]>;
    description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    type: import("@scalar/validation").LiteralSchema<"http">;
    scheme: import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").LiteralSchema<"basic">, import("@scalar/validation").LiteralSchema<"bearer">]>;
    bearerFormat: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>, import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
    type: import("@scalar/validation").LiteralSchema<"oauth2">;
    flows: import("@scalar/validation").ObjectSchema<{
        implicit: import("@scalar/validation").OptionalSchema<import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
            refreshUrl: import("@scalar/validation").StringSchema;
            scopes: import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-security-query': import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-security-body': import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-tokenName': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-secret-auth-url': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-secret-token-url': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            authorizationUrl: import("@scalar/validation").StringSchema;
        }>]>>;
        password: import("@scalar/validation").OptionalSchema<import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
            refreshUrl: import("@scalar/validation").StringSchema;
            scopes: import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-security-query': import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-security-body': import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-tokenName': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-secret-auth-url': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-secret-token-url': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            tokenUrl: import("@scalar/validation").StringSchema;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-credentials-location': import("@scalar/validation").OptionalSchema<import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").LiteralSchema<"header">, import("@scalar/validation").LiteralSchema<"body">]>>;
        }>]>>;
        clientCredentials: import("@scalar/validation").OptionalSchema<import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
            refreshUrl: import("@scalar/validation").StringSchema;
            scopes: import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-security-query': import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-security-body': import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-tokenName': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-secret-auth-url': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-secret-token-url': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            tokenUrl: import("@scalar/validation").StringSchema;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-credentials-location': import("@scalar/validation").OptionalSchema<import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").LiteralSchema<"header">, import("@scalar/validation").LiteralSchema<"body">]>>;
        }>]>>;
        authorizationCode: import("@scalar/validation").OptionalSchema<import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
            refreshUrl: import("@scalar/validation").StringSchema;
            scopes: import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-security-query': import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-security-body': import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-tokenName': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-secret-auth-url': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-secret-token-url': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>, import("@scalar/validation").ObjectSchema<{
            authorizationUrl: import("@scalar/validation").StringSchema;
            tokenUrl: import("@scalar/validation").StringSchema;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-usePkce': import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").LiteralSchema<"no">, import("@scalar/validation").LiteralSchema<"SHA-256">, import("@scalar/validation").LiteralSchema<"plain">]>;
        }>, import("@scalar/validation").ObjectSchema<{
            'x-scalar-credentials-location': import("@scalar/validation").OptionalSchema<import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").LiteralSchema<"header">, import("@scalar/validation").LiteralSchema<"body">]>>;
        }>]>>;
    }>;
    description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-default-scopes': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>>;
}>]>, import("@scalar/validation").ObjectSchema<{
    type: import("@scalar/validation").LiteralSchema<"openIdConnect">;
    openIdConnectUrl: import("@scalar/validation").StringSchema;
    description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>]>;
//# sourceMappingURL=security-schemes.d.ts.map