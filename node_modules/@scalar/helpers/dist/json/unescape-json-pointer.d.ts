/**
 * Unescapes a JSON pointer and decodes URI-encoded values.
 * Use `unescapeJsonPointerSegment` for segments containing literal percent sequences.
 *
 * Examples:
 * /foo~1bar~0baz -> /foo/bar~baz
 */
export declare const unescapeJsonPointer: (uri: string) => string;
//# sourceMappingURL=unescape-json-pointer.d.ts.map