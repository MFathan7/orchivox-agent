import { ZodString } from 'zod';
import { MapNullableType } from '../types';
export declare class StringTransformer {
    transform(zodSchema: ZodString, mapNullableType: MapNullableType): {
        minLength: number | undefined;
        maxLength: number | undefined;
        format: string | undefined;
        pattern: string | undefined;
        type?: ((import("openapi3-ts/oas30").SchemaObjectType | import("openapi3-ts/oas30").SchemaObjectType[]) & (import("openapi3-ts/oas31").SchemaObjectType | import("openapi3-ts/oas31").SchemaObjectType[]) & (import("openapi3-ts/oas32").SchemaObjectType | import("openapi3-ts/oas32").SchemaObjectType[])) | undefined;
        nullable?: boolean | undefined;
    };
    /**
     * Attempts to map Zod strings to known formats
     * https://json-schema.org/understanding-json-schema/reference/string.html#built-in-formats
     * New mappings should use values from the OpenAPI format registry:
     * https://spec.openapis.org/registry/format/
     */
    private mapStringFormat;
}
