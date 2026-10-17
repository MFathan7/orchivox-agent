import { isLocalUrl } from '../url/is-local-url.js';
/** Allows HTTPS, with HTTP reserved for local development hosts and reserved test domains. */
export const isAllowedOAuthUrl = (url) => url.protocol === 'https:' || (url.protocol === 'http:' && isLocalUrl(url.href));
