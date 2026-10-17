import { parseMimeType } from './mime-type.js';
/** Recognize XML media types, including structured suffixes and content-type parameters. */
export const isXmlMediaType = (contentType) => {
    const { subtype } = parseMimeType(contentType);
    return subtype === 'xml' || subtype.endsWith('+xml');
};
