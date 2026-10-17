/**
 * AsyncAPI WebSocket binding (channel / operation / server).
 *
 * @see https://github.com/asyncapi/bindings/tree/master/websockets
 */
export declare const asyncApiWsBindingObject: import("@scalar/validation").ObjectSchema<{
    method: import("@scalar/validation").OptionalSchema<import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").LiteralSchema<"GET">, import("@scalar/validation").LiteralSchema<"POST">]>>;
    query: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    headers: import("@scalar/validation").OptionalSchema<import("@scalar/validation").Schema>;
    bindingVersion: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>;
//# sourceMappingURL=ws-binding.d.ts.map