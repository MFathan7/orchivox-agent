import { lazy, object, optional, record, string } from '@scalar/validation';
import { asyncApiChannelBindingsObject, asyncApiMessageBindingsObject, asyncApiOperationBindingsObject, asyncApiServerBindingsObject, } from './bindings.js';
import { asyncApiChannelsObject } from './channel.js';
import { asyncApiCorrelationIdObject } from './correlation-id.js';
import { asyncApiExternalDocumentationObject } from './external-documentation.js';
import { asyncApiMessageObject } from './message.js';
import { asyncApiMessageTraitObject } from './message-trait.js';
import { asyncApiOperationObject } from './operation.js';
import { asyncApiOperationReplyObject } from './operation-reply.js';
import { asyncApiOperationReplyAddressObject } from './operation-reply-address.js';
import { asyncApiOperationTraitObject } from './operation-trait.js';
import { asyncApiParameterObject } from './parameter.js';
import { recursiveRef } from './reference.js';
import { asyncApiSchemaPayload } from './schema-payload.js';
import { asyncApiSecuritySchemeObject } from './security-scheme.js';
import { asyncApiServerObject } from './server.js';
import { asyncApiServerVariableObject } from './server-variable.js';
import { asyncApiTagObject } from './tag.js';
export const asyncApiComponentsObject = lazy(() => object({
    schemas: optional(record(string(), asyncApiSchemaPayload, {
        typeComment: 'Reusable Multi Format Schema, Schema Object, or Reference Object.',
    })),
    servers: optional(record(string(), asyncApiServerObject)),
    channels: optional(asyncApiChannelsObject),
    operations: optional(record(string(), asyncApiOperationObject)),
    messages: optional(record(string(), asyncApiMessageObject)),
    securitySchemes: optional(record(string(), asyncApiSecuritySchemeObject)),
    serverVariables: optional(record(string(), asyncApiServerVariableObject)),
    parameters: optional(record(string(), asyncApiParameterObject)),
    correlationIds: optional(record(string(), asyncApiCorrelationIdObject)),
    replies: optional(record(string(), asyncApiOperationReplyObject)),
    replyAddresses: optional(record(string(), asyncApiOperationReplyAddressObject)),
    externalDocs: optional(record(string(), asyncApiExternalDocumentationObject)),
    tags: optional(record(string(), asyncApiTagObject)),
    operationTraits: optional(record(string(), asyncApiOperationTraitObject)),
    messageTraits: optional(record(string(), asyncApiMessageTraitObject)),
    serverBindings: optional(record(string(), recursiveRef(asyncApiServerBindingsObject))),
    channelBindings: optional(record(string(), recursiveRef(asyncApiChannelBindingsObject))),
    operationBindings: optional(record(string(), recursiveRef(asyncApiOperationBindingsObject))),
    messageBindings: optional(record(string(), recursiveRef(asyncApiMessageBindingsObject))),
}, {
    typeName: 'AsyncApiComponentsObject',
    typeComment: 'Reusable objects. Definitions here have no effect unless referenced from outside components.',
}));
