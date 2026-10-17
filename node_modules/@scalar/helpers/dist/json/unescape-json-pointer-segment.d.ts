/**
 * Unescapes a JSON Pointer segment while preserving literal percent sequences.
 * URI fragment decoding, when needed, must happen before splitting the pointer into segments.
 *
 * Example: `foo~1bar~0baz%20` -> `foo/bar~baz%20`
 */
export declare const unescapeJsonPointerSegment: (segment: string) => string;
//# sourceMappingURL=unescape-json-pointer-segment.d.ts.map