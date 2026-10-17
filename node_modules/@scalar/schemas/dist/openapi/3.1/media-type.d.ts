import { type Schema } from '@scalar/validation';
export declare const header: import("@scalar/validation").UnionSchema<readonly [import("@scalar/validation").IntersectionSchema<readonly Schema[]>, import("@scalar/validation").IntersectionSchema<readonly Schema[]>]>;
export declare const encoding: import("@scalar/validation").ObjectSchema<{
    contentType: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    headers: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, Schema>>;
}>;
export declare const mediaType: import("@scalar/validation").ObjectSchema<{
    schema: import("@scalar/validation").OptionalSchema<Schema>;
    example: import("@scalar/validation").OptionalSchema<import("@scalar/validation").AnySchema>;
    examples: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, Schema>>;
    encoding: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, import("@scalar/validation").ObjectSchema<{
        contentType: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
        headers: import("@scalar/validation").OptionalSchema<import("@scalar/validation").RecordSchema<import("@scalar/validation").StringSchema, Schema>>;
    }>>>;
}>;
//# sourceMappingURL=media-type.d.ts.map