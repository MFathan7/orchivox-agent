/**
 * Escape a JSON string so it is safe to embed inside an inline script tag.
 * This prevents user content from closing the script tag. Apply only to JSON data,
 * because escaping executable source would change JavaScript operators.
 */
export declare const escapeJsonForInlineScript: (json: string) => string;
//# sourceMappingURL=escape-json-for-inline-script.d.ts.map