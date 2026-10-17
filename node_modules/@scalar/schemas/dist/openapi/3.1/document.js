import { array, intersection, object, optional, record, string } from '@scalar/validation';
import { XOriginalOasVersion, XScalarEnvironments, XScalarIcon, XScalarIsDirty, XScalarNavigation, XScalarOriginalDocumentHash, XScalarOriginalSourceUrl, XScalarRegistryMeta, XScalarWatchMode, } from '../../extensions/document/index.js';
import { XPostResponse, XPreRequest, XScalarActiveEnvironment, XScalarCookies, XScalarOrder, } from '../../extensions/general/index.js';
import { XScalarSelectedServer } from '../../extensions/server/index.js';
import { XTagGroups } from '../../extensions/tag/index.js';
import { components } from '../../openapi/3.1/components.js';
import { externalDocs } from '../../openapi/3.1/external-docs.js';
import { info } from '../../openapi/3.1/info.js';
import { pathItem } from '../../openapi/3.1/path-item.js';
import { recursiveRef } from '../../openapi/3.1/reference.js';
import { securityRequirement } from '../../openapi/3.1/security-requirement.js';
import { server } from '../../openapi/3.1/server.js';
import { tag } from '../../openapi/3.1/tag.js';
const openapiExtensions = intersection([
    XOriginalOasVersion,
    XScalarNavigation,
    XScalarOriginalSourceUrl,
    XTagGroups,
    XScalarEnvironments,
    XScalarSelectedServer,
    XScalarIcon,
    XScalarOrder,
    XScalarCookies,
    XScalarOriginalDocumentHash,
    XScalarIsDirty,
    XScalarActiveEnvironment,
    XScalarWatchMode,
    XScalarRegistryMeta,
    XPreRequest,
    XPostResponse,
], {
    typeName: 'OpenApiExtensions',
    typeComment: 'OpenAPI extensions shared by OpenAPI and AsyncAPI documents.',
});
const openApiDocumentCore = object({
    openapi: string({
        typeComment: 'REQUIRED. This string MUST be the version number of the OpenAPI Specification that the OpenAPI Document uses. The openapi field SHOULD be used by tooling to interpret the OpenAPI Document. This is not related to the API info.version string.',
    }),
    info,
    jsonSchemaDialect: optional(string({
        typeComment: 'The default value for the $schema keyword within Schema Objects contained within this OAS document. This MUST be in the form of a URI.',
    })),
    servers: optional(array(server, {
        typeComment: 'An array of Server Objects, which provide connectivity information to a target server. If the servers field is not provided, or is an empty array, the default value would be a Server Object with a url value of /.',
        typeName: 'OpenApiServers',
    })),
    paths: optional(record(string(), recursiveRef(pathItem), {
        typeComment: 'The available paths and operations for the API.',
        typeName: 'PathsObject',
    })),
    webhooks: optional(record(string(), recursiveRef(pathItem), {
        typeComment: 'The incoming webhooks that MAY be received as part of this API and that the API consumer MAY choose to implement.',
        typeName: 'WebhooksObject',
    })),
    components: optional(components),
    security: optional(array(securityRequirement, {
        typeComment: 'A declaration of which security mechanisms can be used across the API. The list of values includes alternative Security Requirement Objects that can be used. Only one of the Security Requirement Objects need to be satisfied to authorize a request.',
        typeName: 'OpenApiSecurity',
    })),
    tags: optional(array(tag, {
        typeComment: 'A list of tags used by the OpenAPI Description with additional metadata. The order of the tags can be used to reflect on their order by the parsing tools.',
    })),
    externalDocs: optional(externalDocs),
}, { typeName: 'OpenApiDocumentCore' });
export const openApiSchema = intersection([openApiDocumentCore, openapiExtensions], {
    typeName: 'OpenApiDocument',
    typeComment: 'Root OpenAPI 3.1 document including Scalar workspace extensions (OpenApiExtensionsSchema).',
});
