import { array, lazy, nullable, object, optional, record, string, union } from '@scalar/validation';
import { asyncApiChannelBindingsObject } from './bindings.js';
import { asyncApiExternalDocumentationObject } from './external-documentation.js';
import { asyncApiMessagesObject } from './message.js';
import { asyncApiParametersObject } from './parameters.js';
import { asyncApiResolvedReference, recursiveRef } from './reference.js';
import { asyncApiServerObject } from './server.js';
import { asyncApiTagsObject } from './tag.js';
/** Channel Object */
export const asyncApiChannelObject = lazy(() => object({
    address: optional(union([string(), nullable()], { typeComment: 'Channel address or null when unknown.' })),
    messages: optional(asyncApiMessagesObject),
    title: optional(string({ typeComment: 'A human-friendly title for the channel.' })),
    summary: optional(string({ typeComment: 'A short summary of the channel.' })),
    description: optional(string({
        typeComment: 'An optional description of this channel. CommonMark syntax MAY be used for rich text representation.',
    })),
    servers: optional(array(asyncApiResolvedReference(asyncApiServerObject), {
        typeComment: 'References to Server definitions where this channel is available (Reference Objects only in the raw document).',
    })),
    parameters: optional(asyncApiParametersObject),
    tags: optional(asyncApiTagsObject),
    externalDocs: optional(asyncApiExternalDocumentationObject),
    bindings: optional(recursiveRef(asyncApiChannelBindingsObject)),
}, { typeName: 'AsyncApiChannelObject' }));
export const asyncApiChannelsObject = record(string(), recursiveRef(asyncApiChannelObject), {
    typeName: 'AsyncApiChannelsObject',
    typeComment: 'Map of channelId to Channel Object or Reference Object.',
});
