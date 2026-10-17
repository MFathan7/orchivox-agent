export declare const XScalarStabilityValues: {
    readonly Deprecated: "deprecated";
    readonly Experimental: "experimental";
    readonly Stable: "stable";
};
export declare const XScalarStability: import("@scalar/validation").ObjectSchema<{
    'x-scalar-stability': import("@scalar/validation").OptionalSchema<import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").LiteralSchema<"deprecated">, import("@scalar/validation").LiteralSchema<"experimental">, import("@scalar/validation").LiteralSchema<"stable">]>>;
}>;
//# sourceMappingURL=x-scalar-stability.d.ts.map