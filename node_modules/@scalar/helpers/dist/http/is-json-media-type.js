import { parseMimeType } from './mime-type.js';
/** Match JSON media types and structured JSON suffixes, ignoring case and parameters. */
export const isJsonMediaType = (value) => {
    const { subtype } = parseMimeType(value);
    return subtype === 'json' || subtype.endsWith('+json');
};
