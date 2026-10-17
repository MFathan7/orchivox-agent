/**
 * Post response scripts allow to execute arbitrary code after a response is received.
 *
 * This is useful for:
 * - Extracting data from the response, or
 * - Testing the response
 *
 * @example
 * ```yaml
 * x-post-response: |
 *   pm.test("Status code is 200", () => {
 *     pm.response.to.have.status(200)
 *   })
 * ```
 */
export declare const XPostResponse: import("@scalar/validation").ObjectSchema<{
    'x-post-response': import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>;
//# sourceMappingURL=x-post-response.d.ts.map