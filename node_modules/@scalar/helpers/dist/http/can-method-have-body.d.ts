/** HTTP Methods which can have a body */
export declare const BODY_METHODS: Set<string>;
/**
 * Whether Scalar can send this method with a body in the current runtime.
 * Browser-forbidden methods are excluded along with methods whose bodies are unsupported.
 *
 * When running inside Electron, all requests are also allowed to have a body because the underlying
 * undici implementation does not reject it, which matches the behavior users expect from desktop API clients.
 */
export declare const canMethodHaveBody: (method: string, skipElectron?: boolean) => boolean;
/*** We must purge body from requests that cannot accept it, skips the electron check */
export declare const buildSafeBodyRequest: (url: string, init: RequestInit) => Request;
//# sourceMappingURL=can-method-have-body.d.ts.map