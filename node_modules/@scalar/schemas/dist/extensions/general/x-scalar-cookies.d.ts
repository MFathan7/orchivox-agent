export declare const XScalarCookie: import("@scalar/validation").ObjectSchema<{
    name: import("@scalar/validation").StringSchema;
    value: import("@scalar/validation").StringSchema;
    domain: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    path: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    isDisabled: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
}>;
export declare const XScalarCookies: import("@scalar/validation").ObjectSchema<{
    'x-scalar-cookies': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").ObjectSchema<{
        name: import("@scalar/validation").StringSchema;
        value: import("@scalar/validation").StringSchema;
        domain: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        path: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        isDisabled: import("@scalar/validation").OptionalSchema<import("@scalar/validation").BooleanSchema>;
    }>>>;
}>;
//# sourceMappingURL=x-scalar-cookies.d.ts.map