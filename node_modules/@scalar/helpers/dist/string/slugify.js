const RE_NON_WORD = /[^\p{L}\p{M}\p{N}\s_-]/gu;
const RE_SPACES = /[\s_-]+/g;
const RE_TRIM_HYPHENS = /^-+|-+$/g;
/**
 * Matches all Unicode combining marks (accents, diacritics, etc.).
 * Used with NFD-decomposed text so base letters and their marks are
 * separate code points and the marks can be dropped cleanly.
 */
const RE_COMBINING_MARKS = /\p{M}/gu;
/** Cache of compiled non-word regexes keyed by their `allowedSpecialChars` string. */
const reNonWordCache = new Map();
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
export const slugify = (v, options = {}) => {
    const { allowedSpecialChars = '', preserveCase = false, normalizationForm = 'NFC', stripAccents = false } = options;
    // Compile the non-word regex once and cache it for future use.
    const reNonWord = (() => {
        if (allowedSpecialChars.length === 0) {
            return RE_NON_WORD;
        }
        const cached = reNonWordCache.get(allowedSpecialChars);
        if (cached) {
            return cached;
        }
        // Escape user-provided characters so they are treated literally inside the character class.
        const escaped = allowedSpecialChars.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
        const reNonWordWithAllowedSpecialChars = new RegExp(`[^\\p{L}\\p{M}\\p{N}\\s_\\-${escaped}]`, 'gu');
        reNonWordCache.set(allowedSpecialChars, reNonWordWithAllowedSpecialChars);
        return reNonWordWithAllowedSpecialChars;
    })();
    const trimmed = v.slice(0, 255).trim();
    // NFD decomposes accented letters into base letter + combining mark, so the
    // marks can be stripped cleanly with a single regex pass.
    const normalized = stripAccents
        ? trimmed.normalize('NFD').replace(RE_COMBINING_MARKS, '')
        : trimmed.normalize(normalizationForm);
    const result = preserveCase ? normalized : normalized.toLowerCase();
    return result.replace(reNonWord, '').replace(RE_SPACES, '-').replace(RE_TRIM_HYPHENS, '');
};
