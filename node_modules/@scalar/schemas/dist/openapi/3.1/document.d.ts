export declare const openApiSchema: import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
    openapi: import("@scalar/validation").StringSchema;
    info: import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
        title: import("@scalar/validation").StringSchema;
        version: import("@scalar/validation").StringSchema;
        summary: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        termsOfService: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        contact: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ObjectSchema<{
            name: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
            url: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
            email: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>>;
        license: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ObjectSchema<{
            name: import("@scalar/validation").StringSchema;
            identifier: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
            url: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>>;
    }>, import("@scalar/validation").ObjectSchema<{
        'x-scalar-sdk-installation': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").ObjectSchema<{
            lang: import("@scalar/validation").StringSchema;
            description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
            source: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>>>;
    }>, import("@scalar/validation").ObjectSchema<{
        'x-scalar-links': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").ObjectSchema<{
            name: import("@scalar/validation").StringSchema;
            url: import("@scalar/validation").StringSchema;
        }>>>;
    }>]>;
    jsonSchemaDialect: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    servers: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").ObjectSchema<{
        url: import("@scalar/validation").StringSchema;
        description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        variables: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").ObjectSchema<{
            enum: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>>;
            default: import("@scalar/validation").StringSchema;
            description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>>>;
    }>>>;
    paths: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
    webhooks: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
    components: import("@scalar/validation").OptionalSchema<import("@scalar/validation").LazySchema<() => import("@scalar/validation").ObjectSchema<{
        schemas: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
        responses: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
        parameters: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
        examples: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
        requestBodies: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
        headers: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
        securitySchemes: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
        links: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
        callbacks: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
        pathItems: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").Schema>>;
    }>>>;
    security: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>>>>;
    tags: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
        name: import("@scalar/validation").StringSchema;
        summary: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        parent: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        kind: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        externalDocs: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ObjectSchema<{
            url: import("@scalar/validation").StringSchema;
            description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        }>>;
    }>, import("@scalar/validation").ObjectSchema<{
        'x-displayName': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    }>, import("@scalar/validation").ObjectSchema<{
        'x-internal': import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    }>, import("@scalar/validation").ObjectSchema<{
        'x-scalar-ignore': import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    }>, import("@scalar/validation").ObjectSchema<{
        'x-scalar-order': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>>;
    }>]>>>;
    externalDocs: import("@scalar/validation").OptionalSchema<import("@scalar/validation").ObjectSchema<{
        url: import("@scalar/validation").StringSchema;
        description: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    }>>;
}>, import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
    'x-original-oas-version': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-navigation': import("@scalar/validation").OptionalSchema<import("@scalar/validation").AnySchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-original-source-url': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-tagGroups': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").IntersectionSchema<readonly [import("@scalar/validation").ObjectSchema<{
        name: import("@scalar/validation").StringSchema;
        tags: import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>;
    }>, import("@scalar/validation").ObjectSchema<{
        'x-scalar-order': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>>;
    }>]>>>;
}>, import("@scalar/validation").ObjectSchema<{
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
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-selected-server': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-icon': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-order': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").StringSchema>>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-cookies': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").ObjectSchema<{
        name: import("@scalar/validation").StringSchema;
        value: import("@scalar/validation").StringSchema;
        domain: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        path: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        isDisabled: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    }>>>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-original-document-hash': import("@scalar/validation").StringSchema;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-is-dirty': import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-scalar-active-environment': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
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
    'x-pre-request': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>, import("@scalar/validation").ObjectSchema<{
    'x-post-response': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>]>]>;
//# sourceMappingURL=document.d.ts.map