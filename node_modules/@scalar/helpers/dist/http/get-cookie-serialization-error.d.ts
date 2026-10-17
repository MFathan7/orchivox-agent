/**
 * Reports structured cookie declarations that would introduce forbidden comma delimiters.
 * Callers apply this OpenAPI 3.2 rule only after checking the document version.
 * Schema checks catch invalid declarations even when their selected example is empty.
 */
export declare const getCookieSerializationError: (parameter: {
    name: string;
    in: string;
    style?: string;
    explode?: boolean;
    schema?: unknown;
}, value?: unknown) => string | undefined;
//# sourceMappingURL=get-cookie-serialization-error.d.ts.map