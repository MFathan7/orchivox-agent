/** Classify streaming bodies so consumers share one set of supported media types. */
export declare const getStreamFormat: (contentType: string | null | undefined) => "json-lines" | "json-seq" | "sse" | "multipart" | undefined;
/** Identifies response formats whose bodies may continue indefinitely. */
export declare const isStreamingContentType: (contentType: string | null | undefined) => boolean;
//# sourceMappingURL=is-streaming-content-type.d.ts.map