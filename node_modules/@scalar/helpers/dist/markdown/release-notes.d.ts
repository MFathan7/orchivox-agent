/**
 * Serialize curated release notes into the human-readable `RELEASE_NOTES.md`
 * shape used as a derived view next to `RELEASE_NOTES.json`.
 *
 * The Scalar app's "What's new" modal reads structured data from JSON at
 * build time; this module exists so the release-notes generator can still
 * emit a markdown file for humans browsing the repo without maintaining a
 * second hand-written format.
 *
 * Format (one entry per release, caller supplies order — newest first):
 *
 * ```markdown
 * ## 3.5.1 (2026-04-25)
 *
 * ### Smoother request runs and a friendlier slugger
 *
 * A small follow-up to the 3.5.0 release ...
 *
 * - Pending edits are now flushed before a request runs.
 * - Switched to our own slug generator.
 *
 * Rich blocks (images, extra headings) follow the same pattern inside the
 * entry body after the title line.
 *
 * [Read full release notes](https://github.com/scalar/scalar/releases/tag/%40scalar%2Fapi-client%403.5.1)
 * ```
 *
 * Anything before the first `## ` heading is the preamble (passed in via
 * `serializeReleaseNotes` options or defaulted).
 */
/** Free-form paragraph of plain text. */
export type ParagraphBlock = {
    type: 'paragraph';
    text: string;
};
/** Subsection heading inside a release entry. Defaults to level 3. */
export type HeadingBlock = {
    type: 'heading';
    text: string;
    level?: 3 | 4;
};
/** Bullet (or numbered) list. */
export type ListBlock = {
    type: 'list';
    items: string[];
    ordered?: boolean;
};
/** Inline image with optional caption. */
export type ImageBlock = {
    type: 'image';
    src: string;
    alt: string;
    caption?: string;
    width?: number;
    height?: number;
};
/** Inline video clip with optional caption and playback hints. */
export type VideoBlock = {
    type: 'video';
    src: string;
    poster?: string;
    caption?: string;
    autoplay?: boolean;
    loop?: boolean;
    muted?: boolean;
    controls?: boolean;
};
export type HrefBlock = {
    type: 'href';
    href: string;
    label: string;
};
/** Rich content block rendered between other blocks inside a release entry. */
export type ContentBlock = ParagraphBlock | HeadingBlock | ListBlock | ImageBlock | VideoBlock | HrefBlock;
/** One release note row. Mirrors the Scalar app's `ReleaseNote` shape. */
export type ReleaseNoteEntry = {
    /** Semver-style version string (for example `3.5.1`). */
    version: string;
    /** Release date in `YYYY-MM-DD` format. */
    date: string;
    /** Short, sentence-case headline. */
    title: string;
    /** Optional body: paragraphs, lists, headings, images, videos, and links. */
    content?: ContentBlock[];
};
/**
 * Build the default markdown preamble for a product's `RELEASE_NOTES.md`.
 * The JSON file remains the source of truth; this preamble documents that
 * for humans browsing the repo or the Scalar docs site.
 */
export declare const buildReleaseNotesPreamble: (displayName?: string) => string;
/**
 * Serialize a list of entries into a `RELEASE_NOTES.md` document.
 * Entries are emitted in the order provided - callers should sort newest
 * first before calling this function.
 *
 * The output is deterministic for a given preamble and entry list.
 */
export declare const serializeReleaseNotes: (entries: readonly ReleaseNoteEntry[], options?: {
    preamble?: string;
}) => string;
//# sourceMappingURL=release-notes.d.ts.map