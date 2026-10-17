/** Options accepted when serializing a `Set-Cookie` header value. */
export type SerializeCookieOptions = {
    /** Number of seconds until the cookie expires, rendered as `Max-Age`. */
    maxAge?: number;
    /** Domain the cookie is valid for, rendered as `Domain`. */
    domain?: string;
    /** Path the cookie is valid for, rendered as `Path`. */
    path?: string;
    /** Absolute expiry date, rendered as `Expires` using `Date.toUTCString()`. */
    expires?: Date;
    /** Whether to add the `HttpOnly` attribute. */
    httpOnly?: boolean;
    /** Whether to add the `Secure` attribute. */
    secure?: boolean;
    /** Whether to add the `Partitioned` attribute. */
    partitioned?: boolean;
    /** Cookie priority, rendered as `Priority=Low|Medium|High`. */
    priority?: 'low' | 'medium' | 'high' | (string & {});
    /**
     * The `SameSite` attribute.
     *
     * `true` is treated as `Strict`, otherwise `strict`, `lax`, or `none`.
     */
    sameSite?: boolean | 'lax' | 'strict' | 'none' | (string & {});
};
/**
 * Serialize a cookie name, value, and options into a `Set-Cookie` header string.
 *
 * This is a small, ESM-friendly drop-in for the `cookie` package's `serialize` (a.k.a.
 * `stringifySetCookie`) function. The third-party package is CommonJS-only, which breaks
 * Vite dev under pnpm's strict `node_modules` layout, so we reproduce just the behavior we
 * need here.
 *
 * The value is intentionally left raw (not URL-encoded) to match how it was previously
 * called with `encode: (str) => str`.
 */
export declare const serializeCookie: (name: string, value: string, options?: SerializeCookieOptions) => string;
//# sourceMappingURL=serialize-cookie.d.ts.map