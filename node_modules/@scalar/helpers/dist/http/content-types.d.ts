/**
 * Built-in content types that we offer as primary choices in the request body content type dropdown.
 *
 * Additional content types defined on the OpenAPI request body (for example `text/csv` or `application/pdf`)
 * are appended dynamically at the UI level and do not need to be listed here.
 */
export declare const CONTENT_TYPES: {
    readonly 'multipart/form-data': "Multipart Form";
    readonly 'application/x-www-form-urlencoded': "Form URL Encoded";
    readonly 'application/octet-stream': "Binary File";
    readonly 'application/json': "JSON";
    readonly 'application/xml': "XML";
    readonly 'application/yaml': "YAML";
    readonly 'application/edn': "EDN";
    /**
     * Raw body without an automatic `Content-Type` header (user may set one manually).
     */
    readonly other: "Other";
    readonly none: "None";
};
//# sourceMappingURL=content-types.d.ts.map