import { lazy, object, optional, record, string } from '@scalar/validation';
import { callback } from '../../openapi/3.1/callback.js';
import { example } from '../../openapi/3.1/example.js';
import { link } from '../../openapi/3.1/link.js';
import { header } from '../../openapi/3.1/media-type.js';
import { parameter } from '../../openapi/3.1/parameter.js';
import { pathItem } from '../../openapi/3.1/path-item.js';
import { normalRef, recursiveRef } from '../../openapi/3.1/reference.js';
import { requestBody } from '../../openapi/3.1/request-body.js';
import { response } from '../../openapi/3.1/response.js';
import { schema } from '../../openapi/3.1/schema.js';
import { securityScheme } from '../../openapi/3.1/security-schemes.js';
export const components = lazy(() => object({
    schemas: optional(record(string(), normalRef(schema), { typeName: 'ComponentsSchemas' })),
    responses: optional(record(string(), recursiveRef(lazy(() => response)), { typeName: 'ComponentsResponses' })),
    parameters: optional(record(string(), recursiveRef(lazy(() => parameter)), { typeName: 'ComponentsParameters' })),
    examples: optional(record(string(), recursiveRef(lazy(() => example)), { typeName: 'ComponentsExamples' })),
    requestBodies: optional(record(string(), recursiveRef(lazy(() => requestBody)), { typeName: 'ComponentsRequestBodies' })),
    headers: optional(record(string(), recursiveRef(lazy(() => header)), { typeName: 'ComponentsHeaders' })),
    securitySchemes: optional(record(string(), recursiveRef(lazy(() => securityScheme)), { typeName: 'ComponentsSecuritySchemes' })),
    links: optional(record(string(), recursiveRef(lazy(() => link)), { typeName: 'ComponentsLinks' })),
    callbacks: optional(record(string(), recursiveRef(lazy(() => callback)), { typeName: 'ComponentsCallbacks' })),
    pathItems: optional(record(string(), recursiveRef(lazy(() => pathItem)), { typeName: 'ComponentsPathItems' })),
}, { typeName: 'ComponentsObject' }));
