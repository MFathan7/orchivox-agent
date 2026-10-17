/**
 * Fenced code block for typeComment strings (used by type generation for JSDoc).
 * Example bodies are passed through as-is so backticks and `${...}` appear literally in docs.
 */
export declare const typeCommentCodeBlock: (language: string, body: string) => string;
/** `@example` section with a fenced code block for typeComment. */
export declare const typeCommentExample: (language: string, body: string) => string;
/** Inline code span for typeComment strings (for example `` `enum` ``). */
export declare const typeCommentInlineCode: (text: string) => string;
/** Join typeComment sections with a blank line between each. */
export declare const typeCommentSections: (...sections: string[]) => string;
/** Description plus an `@example` fenced code block for typeComment. */
export declare const typeCommentWithExample: (description: string, example: {
    language: string;
    body: string;
}) => string;
//# sourceMappingURL=type-comment.d.ts.map