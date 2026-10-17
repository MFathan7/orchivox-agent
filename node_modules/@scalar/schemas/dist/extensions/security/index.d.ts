/**
 * Security scheme Scalar extensions.
 *
 * Applied on OpenAPI `components.securitySchemes` entries. Configures OAuth2 behavior, credential
 * placement, PKCE, default scopes, and persisted secrets (not exported with the document).
 */
export { XDefaultScopes } from './x-default-scopes.js';
export { XScalarCredentialsLocation } from './x-scalar-credentials-location.js';
export { XScalarSecurityBody } from './x-scalar-security-body.js';
export { XScalarSecurityQuery } from './x-scalar-security-query.js';
export { XScalarAuthUrl, XScalarSecretClientId, XScalarSecretClientSecret, XScalarSecretHTTP, XScalarSecretRedirectUri, XScalarSecretRefreshToken, XScalarSecretToken, XScalarTokenUrl, } from './x-scalar-security-secrets.js';
export { XTokenName } from './x-tokenName.js';
export { XusePkce } from './x-use-pkce.js';
//# sourceMappingURL=index.d.ts.map