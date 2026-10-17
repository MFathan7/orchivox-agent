/**
 * Schema for the x-scalar-selected-content-type extension on an OpenAPI operation.
 *
 * The key represents the example name, and the value is the selected content type string.
 * Used by Scalar to track which content type is selected for each example in request or response bodies.
 */
export declare const XScalarSelectedContentType: import("@scalar/validation").ObjectSchema<{
    'x-scalar-selected-content-type': import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").StringSchema>>;
}>;
//# sourceMappingURL=x-scalar-selected-content-type.d.ts.map