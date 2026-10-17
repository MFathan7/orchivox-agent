/**
 * Unicode normalization forms used by `String.prototype.normalize()`:
 * - `NFC`: canonical decomposition followed by recomposition (default for most text).
 * - `NFD`: canonical decomposition (splits accents from base letters).
 * - `NFKC`: compatibility decomposition followed by recomposition (folds ligatures and width variants).
 * - `NFKD`: compatibility decomposition (like `NFKC` without recomposition).
 */
export type NormalizationForm = 'NFC' | 'NFD' | 'NFKC' | 'NFKD';
export type SlugifyOptions = {
    /**
     * A string of extra characters to allow through the non-word filter.
     * Each character in the string is treated literally.
     * @example '.' // keeps dots: "v1.2.3" → "v1.2.3"
     * @example '.@' // keeps dots and at-signs
     */
    allowedSpecialChars?: string;
    /**
     * When `true`, the result is preserved as-is (i.e. case is preserved). By default we lowercase the string.
     * @default false
     * @example slugify('MyAPI', { preserveCase: true }) // 'MyAPI'
     */
    preserveCase?: boolean;
    /**
     * Unicode normalization form applied to the input before slugifying.
     * Has no effect when `stripAccents` is `true`, which always uses NFD
     * internally to decompose accented letters before stripping them.
     * @default 'NFC'
     * @example slugify('ﬁle', { normalizationForm: 'NFKC' }) // 'file' (ligature → two letters)
     */
    normalizationForm?: NormalizationForm;
    /**
     * When `true`, strips combining diacritical marks (accents) from letters,
     * producing ASCII-friendly slugs from accented text.
     *
     * Internally normalizes to NFD so that base letters and their accent marks
     * become separate code points, then removes all Unicode combining marks
     * (`\p{M}`). This takes precedence over `normalizationForm`.
     *
     * @default false
     * @example slugify('Crème Brûlée', { stripAccents: true }) // 'creme-brulee'
     */
    stripAccents?: boolean;
};
/**
 * Normalizes and slugifies a string.
 *
 * By default the result is lowercased, limited to 255 characters, and stripped
 * of everything that is not a Unicode letter, mark, number, hyphen, or space
 * (spaces and hyphens are then collapsed into a single hyphen).
 *
 * Pass {@link SlugifyOptions} to adjust this behaviour.
 *
 * | Option               | Type                | Default | Description                                                                                                             |
 * |----------------------|---------------------|---------|------------------------------------------------------------------------------------------------------------------------ |
 * | `allowedSpecialChars`| `string`            | `""`    | Extra characters that should survive the non-word filter (e.g. `"."` keeps dots so `"v1.2"` → `"v1.2"` instead of `"v12"`). |
 * | `preserveCase`       | `boolean`           | `false` | When `true`, the case is preserved. By default we lowercase the string.                                                 |
 * | `normalizationForm`  | `NormalizationForm` | `'NFC'` | Unicode normalization form to apply. Ignored when `stripAccents` is `true`.                                             |
 * | `stripAccents`       | `boolean`           | `false` | When `true`, strips diacritical marks so e.g. `"Crème"` → `"creme"`. Takes precedence over `normalizationForm`.        |
 */
export declare const slugify: (v: string, options?: SlugifyOptions) => string;
//# sourceMappingURL=slugify.d.ts.map