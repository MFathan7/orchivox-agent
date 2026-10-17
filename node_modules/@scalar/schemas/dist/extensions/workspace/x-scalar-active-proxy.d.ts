/**
 * Schema for the x-scalar-active-proxy extension.
 *
 * This property indicates the currently selected proxy identifier.
 *
 * @example
 * ```json
 * { "x-scalar-active-proxy": "my-proxy-id" }
 * ```
 */
export declare const XScalarActiveProxy: import("@scalar/validation").ObjectSchema<{
    'x-scalar-active-proxy': import("@scalar/validation").OptionalSchema<import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").StringSchema, import("@scalar/validation").NullableSchema]>>;
}>;
//# sourceMappingURL=x-scalar-active-proxy.d.ts.map