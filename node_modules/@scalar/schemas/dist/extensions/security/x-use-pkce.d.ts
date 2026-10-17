/**
 * Use `x-usePkce` to enable Proof Key for Code Exchange (PKCE) for the OAuth2 authorization code flow.
 */
export declare const XusePkce: import("@scalar/validation").ObjectSchema<{
    'x-usePkce': import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").LiteralSchema<"no">, import("@scalar/validation").LiteralSchema<"SHA-256">, import("@scalar/validation").LiteralSchema<"plain">]>;
}>;
//# sourceMappingURL=x-use-pkce.d.ts.map