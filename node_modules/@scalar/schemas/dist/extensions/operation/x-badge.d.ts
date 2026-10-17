/**
 * Schema for individual badge configuration in the x-badges extension.
 * Badges are indicators that can be displayed in API documentation.
 */
export declare const XBadge: import("@scalar/validation").ObjectSchema<{
    name: import("@scalar/validation").StringSchema;
    position: import("@scalar/validation").OptionalSchema<import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").LiteralSchema<"before">, import("@scalar/validation").LiteralSchema<"after">]>>;
    color: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>;
/**
 * Badges for an operation in the Scalar UI.
 *
 * You can add badges to operations to use as indicators in documentation. Each operation can have multiple badges,
 * and the displayed color is also configurable.
 *
 * @example
 * ```yaml
 * paths:
 *   /hello-world:
 *     get:
 *       summary: Hello World
 *       x-badges:
 *         - name: Alpha
 *         - name: Beta
 *           position: before
 *         - name: Gamma
 *           position: after
 *           color: "#ffcc00"
 * ```
 */
export declare const XBadges: import("@scalar/validation").ObjectSchema<{
    'x-badges': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").ObjectSchema<{
        name: import("@scalar/validation").StringSchema;
        position: import("@scalar/validation").OptionalSchema<import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").LiteralSchema<"before">, import("@scalar/validation").LiteralSchema<"after">]>>;
        color: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    }>>>;
}>;
//# sourceMappingURL=x-badge.d.ts.map