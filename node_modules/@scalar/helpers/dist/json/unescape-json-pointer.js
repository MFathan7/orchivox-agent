import { unescapeJsonPointerSegment } from './unescape-json-pointer-segment.js';
/**
 * Unescapes a JSON pointer and decodes URI-encoded values.
 * Use `unescapeJsonPointerSegment` for segments containing literal percent sequences.
 *
 * Examples:
 * /foo~1bar~0baz -> /foo/bar~baz
 */
export const unescapeJsonPointer = (uri) => decodeURI(unescapeJsonPointerSegment(uri));
