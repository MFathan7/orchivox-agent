/**
 * Takes JSON and formats it.
 */
export declare const prettyPrintJson: (value: string | number | any[] | Record<any, any>) => string;
/**
 * JSON.stringify, but with circular references replaced with '[Circular]'.
 *
 * Only references that are already on the current path are collapsed, so the same object used in
 * two sibling positions is expanded in both. Expanding a deeply shared graph can still blow up
 * exponentially, so the number of emitted nodes is capped: once it passes MAX_EXPANDED_NODES the
 * walk throws EXPANSION_LIMIT_EXCEEDED, which prettyPrintJson catches to fall back to collapsing
 * every repeated reference.
 */
export declare function replaceCircularDependencies(content: any): string;
//# sourceMappingURL=pretty-print-json.d.ts.map