import { array, object, optional, string } from '@scalar/validation';
import { asyncApiMessageBindingsObject } from './bindings.js';
import { asyncApiCorrelationIdObject } from './correlation-id.js';
import { asyncApiExternalDocumentationObject } from './external-documentation.js';
import { asyncApiMessageExampleObject } from './message-example.js';
import { recursiveRef } from './reference.js';
import { asyncApiSchemaPayload } from './schema-payload.js';
import { asyncApiTagsObject } from './tag.js';
/** Message Trait Object | Reference Object */
export const asyncApiMessageTraitObject = recursiveRef(object({
    headers: optional(asyncApiSchemaPayload),
    correlationId: optional(asyncApiCorrelationIdObject),
    contentType: optional(string({
        typeComment: 'The content type to use when encoding/decoding a message payload (for example application/json).',
    })),
    name: optional(string({ typeComment: 'A machine-friendly name for the message.' })),
    title: optional(string({ typeComment: 'A human-friendly title for the message.' })),
    summary: optional(string({ typeComment: 'A short summary of what the message is about.' })),
    description: optional(string({
        typeComment: 'A verbose explanation of the message. CommonMark syntax MAY be used for rich text representation.',
    })),
    tags: optional(asyncApiTagsObject),
    externalDocs: optional(asyncApiExternalDocumentationObject),
    bindings: optional(recursiveRef(asyncApiMessageBindingsObject)),
    examples: optional(array(recursiveRef(asyncApiMessageExampleObject))),
}, { typeName: 'AsyncApiMessageTraitObject' }));
