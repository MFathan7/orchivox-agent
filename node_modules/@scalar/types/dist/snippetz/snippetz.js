import { objectEntries } from '@scalar/helpers/object/object-entries';
/**
 * Maps programming languages and environments to their available HTTP clients.
 * Each key is a target (language/environment), and each value is an array of
 * client identifiers in the format `target/client`.
 *
 * This is the source of truth for all supported code generation targets.
 */
export const GROUPED_CLIENTS = {
    c: ['libcurl'],
    clojure: ['clj_http'],
    csharp: ['httpclient', 'restsharp'],
    dart: ['http'],
    fsharp: ['httpclient'],
    go: ['native'],
    http: ['http1.1'],
    java: ['asynchttp', 'nethttp', 'okhttp', 'unirest'],
    js: ['axios', 'fetch', 'jquery', 'ofetch', 'xhr'],
    julia: ['http'],
    kotlin: ['okhttp'],
    node: ['axios', 'fetch', 'ofetch', 'undici'],
    objc: ['nsurlsession'],
    ocaml: ['cohttp'],
    php: ['curl', 'guzzle', 'laravel'],
    powershell: ['restmethod', 'webrequest'],
    python: ['python3', 'requests', 'aiohttp', 'httpx_sync', 'httpx_async'],
    r: ['httr2'],
    ruby: ['native'],
    rust: ['reqwest'],
    shell: ['curl', 'httpie', 'wget'],
    swift: ['nsurlsession'],
};
/**
 * Flat array of all available client identifiers.
 * Each identifier follows the format `target/client` (e.g., `js/fetch`, `python/requests`).
 */
export const AVAILABLE_CLIENTS = objectEntries(GROUPED_CLIENTS).flatMap(([group, clients]) => clients.map((client) => `${group}/${client}`));
